import { randomUUID } from 'node:crypto'
import { linkTtlMinutesFor } from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueVendorLink, verifyVendorLink } from './link.ts'
import { reissueOnExpiry } from './reissue.ts'

// An expired link is not a dead end (D-6, D-16, R-032d).
//
// The tests that matter are the REFUSALS. This path mints a live credential
// from a dead one, so what it declines to do is the whole safety argument:
// it never reissues for a job that is no longer this vendor's, never for a
// link a PM deliberately revoked, and never for a token we did not issue.

let entityId: string
let propertyId: string
let unitId: string
let vendorId: string
let otherVendorId: string

beforeAll(async () => {
  const stamp = `reissue-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '8 Expiry Lane',
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
  const vendor = await prisma.vendor.create({
    data: { name: `Slow-${randomUUID().slice(0, 6)}`, trades: ['PLUMBING'], phone: '+15125550111' },
  })
  vendorId = vendor.id
  const other = await prisma.vendor.create({
    data: { name: `Other-${randomUUID().slice(0, 6)}`, trades: ['PLUMBING'] },
  })
  otherVendorId = other.id
})

afterAll(async () => {
  await prisma.vendor.updateMany({
    where: { id: { in: [vendorId, otherVendorId] } },
    data: { active: false },
  })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/// Every work order this file creates, so a count can be scoped to them.
const seededJobIds: string[] = []

async function seedJob(priority: 'EMERGENCY' | 'URGENT' | 'ROUTINE' = 'ROUTINE') {
  const job = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      vendorId,
      scope: 'Service the boiler',
      priority,
      status: 'ASSIGNED',
      dispatchedAt: new Date(),
    },
  })
  seededJobIds.push(job.id)
  return job
}

/// Ages a link past its expiry without waiting for real time.
async function expire(workOrderId: string) {
  await prisma.authToken.updateMany({
    where: { purpose: 'VENDOR_WORK_ORDER', subjectId: workOrderId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  })
}

describe('link lifetime by priority', () => {
  it('gives routine work a fortnight and an emergency three days', async () => {
    // D-16's single number was tuned for a same-week job: routine work is
    // booked out a week and the link died before the vendor arrived.
    expect(linkTtlMinutesFor('ROUTINE')).toBe(14 * 24 * 60)
    expect(linkTtlMinutesFor('EMERGENCY')).toBe(3 * 24 * 60)
    expect(linkTtlMinutesFor('URGENT')).toBe(3 * 24 * 60)
    // An unknown priority gets the SAFE-for-the-vendor default rather than
    // throwing on a page a plumber is standing in front of.
    expect(linkTtlMinutesFor('WHATEVER')).toBe(14 * 24 * 60)
  })

  it('mints the routine lifetime from the work order, not from the caller', async () => {
    const routine = await seedJob('ROUTINE')
    const emergency = await seedJob('EMERGENCY')

    const a = await issueVendorLink(routine.id, vendorId)
    const b = await issueVendorLink(emergency.id, vendorId)

    // Compared to each other rather than to a wall-clock instant, so the
    // assertion does not drift with how long the test takes.
    expect(a.expiresAt.getTime()).toBeGreaterThan(b.expiresAt.getTime())
  }, 20_000)
})

describe('reissueOnExpiry', () => {
  it('sends the vendor a fresh link, and the old one stays dead', async () => {
    const workOrder = await seedJob()
    const first = await issueVendorLink(workOrder.id, vendorId)
    await expire(workOrder.id)

    const result = await reissueOnExpiry(first.token)
    expect(result).toEqual({ reissued: true })

    // The tapped link is NOT revived — a new one was minted and texted.
    expect((await verifyVendorLink(first.token)).ok).toBe(false)
    const live = await prisma.authToken.count({
      where: {
        purpose: 'VENDOR_WORK_ORDER',
        subjectId: workOrder.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
    })
    expect(live).toBe(1)
  }, 20_000)

  it('REFUSES once the job has moved to another vendor', async () => {
    // The same gate a live link passes. Expiry must not become a way around
    // the access rules.
    const workOrder = await seedJob()
    const { token } = await issueVendorLink(workOrder.id, vendorId)
    await expire(workOrder.id)
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { vendorId: otherVendorId },
    })

    const result = await reissueOnExpiry(token)
    expect(result).toEqual({ reissued: false, reason: 'not_actionable' })
  }, 20_000)

  it('REFUSES on a job that is no longer actionable', async () => {
    const workOrder = await seedJob()
    const { token } = await issueVendorLink(workOrder.id, vendorId)
    await expire(workOrder.id)
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { status: 'CANCELED' },
    })

    expect(await reissueOnExpiry(token)).toEqual({
      reissued: false,
      reason: 'not_actionable',
    })
  }, 20_000)

  it('REFUSES a link a PM deliberately revoked', async () => {
    // Reissuing a revoked link would undo somebody cutting off a link they
    // texted to the wrong number — D-16's stated way to kill one.
    const workOrder = await seedJob()
    const { token } = await issueVendorLink(workOrder.id, vendorId)
    await prisma.authToken.updateMany({
      where: { purpose: 'VENDOR_WORK_ORDER', subjectId: workOrder.id },
      data: { consumedAt: new Date() },
    })

    const result = await reissueOnExpiry(token)
    expect(result.reissued).toBe(false)
  }, 20_000)

  it('REFUSES a token that is still live', async () => {
    const workOrder = await seedJob()
    const { token } = await issueVendorLink(workOrder.id, vendorId)

    expect(await reissueOnExpiry(token)).toEqual({ reissued: false, reason: 'unknown' })
  }, 20_000)

  it('REFUSES a forged token, minting nothing', async () => {
    // The one thing this must never do: mint a link for a guessed id.
    //
    // SCOPED TO THIS FILE'S OWN JOBS (R-109). Counting every
    // VENDOR_WORK_ORDER token in the database is red the moment any other
    // file mints one between the two reads, and vitest runs files in
    // parallel: it lost at 1842 against an expected 1841, having passed
    // alone every time. Scoping is not quite the usual substitution here
    // because the assertion is about the ABSENCE of a row rather than the
    // presence of one - but the only mint path in `reissueOnExpiry` is
    // `issueVendorLink(workOrder.id, ...)` for a work order resolved from
    // the token, and the only work orders a token in this database could
    // resolve to and this file could have been the cause of are its own.
    const before = await prisma.authToken.count({
      where: { purpose: 'VENDOR_WORK_ORDER', subjectId: { in: seededJobIds } },
    })
    expect(await reissueOnExpiry('not-a-real-token')).toEqual({
      reissued: false,
      reason: 'unknown',
    })
    expect(
      await prisma.authToken.count({
        where: { purpose: 'VENDOR_WORK_ORDER', subjectId: { in: seededJobIds } },
      }),
    ).toBe(before)
  }, 20_000)

  it('sends ONE message however many times the dead link is tapped', async () => {
    // A vendor refreshing the page must not text themselves five links.
    const workOrder = await seedJob()
    const { token } = await issueVendorLink(workOrder.id, vendorId)
    await expire(workOrder.id)

    await reissueOnExpiry(token)
    const after = await prisma.notification.count({
      where: { idempotencyKey: { startsWith: `vendor-reissue:${workOrder.id}:` } },
    })

    // The second tap hits an ALREADY-EXPIRED token whose expiry instant is
    // unchanged, so the idempotency key is the same and no second message is
    // written.
    await reissueOnExpiry(token)
    expect(
      await prisma.notification.count({
        where: { idempotencyKey: { startsWith: `vendor-reissue:${workOrder.id}:` } },
      }),
    ).toBe(after)
  }, 20_000)
})
