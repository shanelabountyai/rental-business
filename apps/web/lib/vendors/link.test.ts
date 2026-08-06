import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueVendorLink, revokeVendorLinks, verifyVendorLink } from './link.ts'

// The vendor magic link against a real database (D-6, D-16, R-025).
//
// This is the ONLY authorization a vendor has, and it is a multi-use bearer
// token - so the tests that matter most are the ones that prove each control
// in D-16's replacement set actually holds: scoped, expiring, revocable,
// dies with the job, dies on reassignment. A failure in any one of them is
// the whole argument for multi-use collapsing.

let propertyId: string
let unitId: string
let vendorAId: string
let vendorBId: string
const propertyIds: string[] = []
const workOrderIds: string[] = []
const vendorIds: string[] = []

beforeAll(async () => {
  const stamp = `vlink-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${stamp}-house`,
      addressLine1: '4 Link Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId, name: 'Unit A', status: 'OCCUPIED' },
  })
  unitId = unit.id

  const a = await prisma.vendor.create({ data: { name: `${stamp}-A`, trades: ['plumbing'] } })
  const b = await prisma.vendor.create({ data: { name: `${stamp}-B`, trades: ['plumbing'] } })
  vendorAId = a.id
  vendorBId = b.id
  vendorIds.push(a.id, b.id)
})

afterAll(async () => {
  await prisma.authToken.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.unit.deleteMany({ where: { propertyId } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedWorkOrder(vendorId: string | null = vendorAId, status = 'ASSIGNED') {
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      vendorId,
      status: status as never,
      scope: 'Fix the tap',
      priority: 'ROUTINE',
    },
  })
  workOrderIds.push(workOrder.id)
  return workOrder
}

describe('issueVendorLink', () => {
  it('mints a link that verifies, and stores only the hash', async () => {
    const workOrder = await seedWorkOrder()
    const { token } = await issueVendorLink(workOrder.id, vendorAId)

    const verified = await verifyVendorLink(token)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.workOrder.id).toBe(workOrder.id)
    expect(verified.vendorId).toBe(vendorAId)

    // A dump of AuthToken must yield nothing anyone can click.
    const stored = await prisma.authToken.findFirst({ where: { subjectId: workOrder.id } })
    expect(stored).not.toBeNull()
    expect(stored!.tokenHash).not.toBe(token)
    expect(JSON.stringify(stored)).not.toContain(token)
  })

  it('WORKS REPEATEDLY - the whole point of D-16', async () => {
    // Single-use would break the plumber who accepts at 7am and uploads the
    // invoice at 4pm. Three verifications, no consumption.
    const workOrder = await seedWorkOrder()
    const { token } = await issueVendorLink(workOrder.id, vendorAId)

    for (let i = 0; i < 3; i += 1) {
      const verified = await verifyVendorLink(token)
      expect(verified.ok, `attempt ${i + 1}`).toBe(true)
    }
    const stored = await prisma.authToken.findFirstOrThrow({
      where: { subjectId: workOrder.id },
    })
    expect(stored.consumedAt).toBeNull()
  })

  it('REVOKES every earlier link when reissued - resending is how a leak is killed', async () => {
    const workOrder = await seedWorkOrder()
    const first = await issueVendorLink(workOrder.id, vendorAId)
    expect((await verifyVendorLink(first.token)).ok).toBe(true)

    const second = await issueVendorLink(workOrder.id, vendorAId)

    const oldVerdict = await verifyVendorLink(first.token)
    expect(oldVerdict.ok).toBe(false)
    if (!oldVerdict.ok) expect(oldVerdict.reason).toBe('already_used')
    expect((await verifyVendorLink(second.token)).ok).toBe(true)
  })
})

describe('verifyVendorLink refuses', () => {
  it('a token that was never issued', async () => {
    const verdict = await verifyVendorLink('not-a-real-token')
    expect(verdict).toEqual({ ok: false, reason: 'not_found' })
  })

  it('an expired token', async () => {
    const workOrder = await seedWorkOrder()
    const { token } = await issueVendorLink(workOrder.id, vendorAId)

    // Four days out - past the three-day TTL.
    const later = new Date(Date.now() + 4 * 24 * 60 * 60_000)
    const verdict = await verifyVendorLink(token, later)
    expect(verdict).toEqual({ ok: false, reason: 'expired' })
  })

  it('an explicitly revoked token', async () => {
    const workOrder = await seedWorkOrder()
    const { token } = await issueVendorLink(workOrder.id, vendorAId)
    const revoked = await revokeVendorLinks(workOrder.id)
    expect(revoked).toBe(1)

    const verdict = await verifyVendorLink(token)
    expect(verdict).toEqual({ ok: false, reason: 'already_used' })
  })

  it('THE REASSIGNED VENDOR - an un-expired link the office cannot un-send', async () => {
    // The single most important test in this file. Vendor A holds a live
    // link. The job is handed to vendor B. A's token has not expired and
    // cannot be recalled from their phone, so only the vendor comparison
    // stops them opening a gate code for a job that is no longer theirs.
    const workOrder = await seedWorkOrder(vendorAId)
    const { token } = await issueVendorLink(workOrder.id, vendorAId)
    expect((await verifyVendorLink(token)).ok).toBe(true)

    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { vendorId: vendorBId },
    })

    const verdict = await verifyVendorLink(token)
    expect(verdict).toEqual({ ok: false, reason: 'reassigned' })
  })

  it('a link whose job has been closed or canceled', async () => {
    for (const status of ['CLOSED', 'CANCELED']) {
      const workOrder = await seedWorkOrder(vendorAId)
      const { token } = await issueVendorLink(workOrder.id, vendorAId)
      await prisma.workOrder.update({
        where: { id: workOrder.id },
        data: { status: status as never },
      })
      const verdict = await verifyVendorLink(token)
      expect(verdict, status).toEqual({ ok: false, reason: 'not_actionable' })
    }
  })

  it('a token issued for a DIFFERENT purpose entirely', async () => {
    // Purpose separation: a tenant magic link must never open a work order,
    // however valid it is as a tenant magic link.
    const workOrder = await seedWorkOrder()
    const { token } = await issueVendorLink(workOrder.id, vendorAId)
    await prisma.authToken.updateMany({
      where: { subjectId: workOrder.id },
      data: { purpose: 'TENANT_MAGIC_LINK' },
    })

    const verdict = await verifyVendorLink(token)
    expect(verdict).toEqual({ ok: false, reason: 'wrong_purpose' })
  })

  it('a token carrying no vendor in its metadata', async () => {
    // Defence against a hand-written or migrated row: with no vendor to
    // compare against, "is this still your job" is unanswerable, so the
    // answer is no.
    const workOrder = await seedWorkOrder()
    const { token } = await issueVendorLink(workOrder.id, vendorAId)
    await prisma.authToken.updateMany({
      where: { subjectId: workOrder.id },
      data: { metadata: {} },
    })

    const verdict = await verifyVendorLink(token)
    expect(verdict).toEqual({ ok: false, reason: 'wrong_subject' })
  })
})
