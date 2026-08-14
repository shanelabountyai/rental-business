import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { issueVendorLink } from '@/lib/vendors/link.ts'
import { issueVerifyLink, verifyVerifyLink } from './verify-link.ts'
import { answerFromLink } from './verify-link-actions.ts'

// The tenant's one tap, without a login wall (MAINT-07, R-032c).
//
// This token is the only thing standing between a URL in a text message and
// a work order changing state, so the tests are about what it REFUSES more
// than what it allows.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let otherTenantId: string
let vendorId: string

beforeAll(async () => {
  const stamp = `vlink-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '5 Verify Street',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    // NO EMAIL. The persona this item exists for: a phone and nothing else,
    // who could not have answered through the portal at all.
    data: { firstName: 'Dana', lastName: `Phone-${randomUUID().slice(0, 6)}`, email: null },
  })
  tenantId = tenant.id
  const other = await prisma.tenant.create({
    data: { firstName: 'Someone', lastName: `Else-${randomUUID().slice(0, 6)}` },
  })
  otherTenantId = other.id
  const vendor = await prisma.vendor.create({
    data: { name: `Fix-${randomUUID().slice(0, 6)}`, trades: ['PLUMBING'] },
  })
  vendorId = vendor.id
})

afterAll(async () => {
  await prisma.tenant.updateMany({
    where: { id: { in: [tenantId, otherTenantId] } },
    data: { active: false },
  })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedCompleteJob(owner = tenantId) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId: owner,
      source: 'SMS',
      category: 'PLUMBING',
      description: 'Kitchen tap drips constantly',
      priority: 'ROUTINE',
      status: 'TRIAGED',
    },
  })
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId: ticket.id,
      vendorId,
      scope: 'R/R cartridge, kitchen mixer',
      priority: 'ROUTINE',
      status: 'WORK_COMPLETE',
      completedAt: new Date(),
    },
  })
  return { ticket, workOrder }
}

const issueFor = (workOrderId: string, owner = tenantId, round = 1) =>
  issueVerifyLink({ workOrderId, tenantId: owner, round })

describe('verifyVerifyLink', () => {
  it('opens the question for the tenant it was minted for', async () => {
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)

    const result = await verifyVerifyLink(token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tenantId).toBe(tenantId)
    expect(result.workOrderId).toBe(workOrder.id)
    // The TENANT's words, not the internal scope — what they will recognise.
    expect(result.job.requestSummary).toContain('Kitchen tap')
  }, 20_000)

  it('REFUSES a vendor token, though the hashes share one table', async () => {
    // The purpose check is the whole reason this matters: every token in the
    // product lives in AuthToken, and without comparing purpose a vendor's
    // dispatch link would authenticate a tenant's answer.
    const { workOrder } = await seedCompleteJob()
    const vendorLink = await issueVendorLink(workOrder.id, vendorId)

    const result = await verifyVerifyLink(vendorLink.token)
    expect(result.ok).toBe(false)
  }, 20_000)

  it('refuses a forged token', async () => {
    expect((await verifyVerifyLink('not-a-real-token')).ok).toBe(false)
  }, 20_000)

  it('refuses once the round has moved on', async () => {
    // A tenant who kept the first text must not be able to answer the second
    // question with it — otherwise they could close a repair they never saw
    // the second attempt at.
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id, tenantId, 1)
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { reopenCount: 1 },
    })

    const result = await verifyVerifyLink(token)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('stale_round')
  }, 20_000)

  it('reissuing kills the previous link', async () => {
    const { workOrder } = await seedCompleteJob()
    const first = await issueFor(workOrder.id)
    await issueFor(workOrder.id)

    const result = await verifyVerifyLink(first.token)
    expect(result.ok).toBe(false)
  }, 20_000)

  it('says ANSWERED rather than broken once the question is settled', async () => {
    // A distinct outcome on purpose: "this link is not working" sends
    // somebody to the phone, which is what this item exists to stop.
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)
    await prisma.workOrderVerification.create({
      data: { workOrderId: workOrder.id, tenantId, round: 1, resolved: true },
    })

    const result = await verifyVerifyLink(token)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('answered')
  }, 20_000)

  it('refuses when the ticket belongs to a different tenant', async () => {
    const { workOrder } = await seedCompleteJob(otherTenantId)
    // Minted naming OUR tenant against somebody else's ticket — the shape a
    // mistake or a tampered metadata row would take.
    const { token } = await issueFor(workOrder.id, tenantId)

    expect((await verifyVerifyLink(token)).ok).toBe(false)
  }, 20_000)
})

describe('answerFromLink', () => {
  const form = (answer: string, comment?: string) => {
    const data = new FormData()
    data.set('resolved', answer)
    if (comment) data.set('comment', comment)
    return data
  }

  it('records a YES and verifies the job, with no session anywhere', async () => {
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)

    const state = await answerFromLink(token, {}, form('yes'))
    expect(state.error).toBeUndefined()
    expect(state.answered).toBe(true)

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('VERIFIED')
    const row = await prisma.workOrderVerification.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(row.resolved).toBe(true)
    // The vendor is captured on the ANSWER (D-19), not read off the work
    // order later.
    expect(row.vendorId).toBe(vendorId)
  }, 20_000)

  it('records a NO, reopens the job, and keeps the note', async () => {
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)

    const state = await answerFromLink(token, {}, form('no', 'Still dripping overnight'))
    expect(state.error).toBeUndefined()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('SUBMITTED')
    expect(after.reopenCount).toBe(1)
    // Cleared, because the completion has been contradicted.
    expect(after.verifiedAt).toBeNull()
    expect(after.completedAt).toBeNull()

    const row = await prisma.workOrderVerification.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(row.comment).toBe('Still dripping overnight')
  }, 20_000)

  it('is answered ONCE however many times the button is pressed', async () => {
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)

    await answerFromLink(token, {}, form('yes'))
    const second = await answerFromLink(token, {}, form('no'))

    // The second press is refused as already-answered, NOT recorded as a
    // reopen — the answer is once-only even though the link is multi-use.
    expect(second.answered).toBe(true)
    expect(
      await prisma.workOrderVerification.count({ where: { workOrderId: workOrder.id } }),
    ).toBe(1)
    const after = await prisma.workOrderVerification.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(after.resolved).toBe(true)
  }, 20_000)

  it('re-verifies the token on the WRITE, not just the render', async () => {
    // The page can be stale and the form field is attacker-controlled.
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)
    // Revoked between render and submit, exactly as a resend would do.
    await prisma.authToken.updateMany({
      where: { purpose: 'TENANT_VERIFY', subjectId: workOrder.id },
      data: { consumedAt: new Date() },
    })

    const state = await answerFromLink(token, {}, form('yes'))
    expect(state.error).toBeTruthy()
    expect(
      await prisma.workOrderVerification.count({ where: { workOrderId: workOrder.id } }),
    ).toBe(0)
  }, 20_000)

  it('refuses an answer that is neither yes nor no', async () => {
    const { workOrder } = await seedCompleteJob()
    const { token } = await issueFor(workOrder.id)

    const state = await answerFromLink(token, {}, form('maybe'))
    expect(state.error).toBeTruthy()
    expect(
      await prisma.workOrderVerification.count({ where: { workOrderId: workOrder.id } }),
    ).toBe(0)
  }, 20_000)
})
