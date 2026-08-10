import { randomUUID } from 'node:crypto'
import { CONDITION_BASELINE_DOCUMENT_TYPE } from '@rental/core/leases'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { outstandingIntakeGaps, raiseIntakeTasks } from './intake.ts'
import { hasConditionBaseline, listLeases } from './queries.ts'

// The inherited-tenancy intake against a real database (RISK-08, R-033).
//
// The assertion that matters most: the outstanding items are raised as
// ordinary `Task` rows in the ONE queue (D-9), not into some acquisition
// checklist of their own - and they keep being raised, daily, until somebody
// actually answers. Going quiet after one ask is exactly how an
// unquantified deposit liability survives to move-out.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
const leaseIds: string[] = []
const documentIds: string[] = []

beforeAll(async () => {
  const stamp = `intake-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '8 Acquisition Avenue',
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
    data: { firstName: 'Grant', lastName: `Inherited-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { subjectId: { in: leaseIds } } })
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  // Deactivated, not deleted: lease.created writes an audit row carrying
  // this property's id, and AuditLog refuses the cascading update.
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedLease(
  overrides: {
    origin?: 'APPLICATION' | 'INHERITED'
    depositTransferStatus?: string
    estoppelConfirmedAt?: Date | null
    withTenant?: boolean
  } = {},
) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'MONTH_TO_MONTH',
      origin: overrides.origin ?? 'INHERITED',
      depositTransferStatus: (overrides.depositTransferStatus ?? 'UNKNOWN') as never,
      estoppelConfirmedAt: overrides.estoppelConfirmedAt ?? null,
      startsOn: new Date('2024-01-01'),
      rentCents: 200_000,
      depositCents: 200_000,
      isMonthToMonth: true,
    },
  })
  leaseIds.push(lease.id)
  if (overrides.withTenant !== false) {
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId, isPrimary: true },
    })
  }
  return lease
}

describe('raiseIntakeTasks', () => {
  it('raises one Task per outstanding item, in the ONE queue', async () => {
    const lease = await seedLease()
    const result = await raiseIntakeTasks(lease.id)

    expect(result.raised).toBe(3)
    const tasks = await prisma.task.findMany({
      where: { subjectId: lease.id, subjectType: 'Lease' },
      select: { type: true, priority: true, title: true },
    })
    expect(tasks.map((t) => t.type).sort()).toEqual([
      'lease_condition_baseline',
      'lease_deposit_transfer',
      'lease_estoppel_confirmation',
    ])
    // URGENT, not routine: the window in which the seller still answers and
    // the paint still looks how it looked at closing is measured in weeks.
    expect(tasks.every((t) => t.priority === 'URGENT')).toBe(true)
  })

  it('names the tenant in the estoppel task, so a PM knows who to call', async () => {
    const lease = await seedLease()
    await raiseIntakeTasks(lease.id)
    const task = await prisma.task.findFirstOrThrow({
      where: { subjectId: lease.id, type: 'lease_estoppel_confirmation' },
    })
    expect(task.title).toContain('Grant')
  })

  it('raises nothing at all for a lease that came through the front door', async () => {
    const lease = await seedLease({
      origin: 'APPLICATION',
      depositTransferStatus: 'NOT_APPLICABLE',
    })
    const result = await raiseIntakeTasks(lease.id)
    expect(result.raised).toBe(0)
    expect(await prisma.task.count({ where: { subjectId: lease.id } })).toBe(0)
  })

  it('is idempotent within a day, and asks again the next one', async () => {
    // createTask's key is (type, subjectId, businessDate). Calling twice
    // today raises nothing the second time; tomorrow is a fresh prompt,
    // which is the right cadence for something that gets harder every week.
    const lease = await seedLease()
    const first = await raiseIntakeTasks(lease.id, new Date('2026-08-10T15:00:00Z'))
    const second = await raiseIntakeTasks(lease.id, new Date('2026-08-10T20:00:00Z'))
    const nextDay = await raiseIntakeTasks(lease.id, new Date('2026-08-11T15:00:00Z'))

    expect(first.raised).toBe(3)
    expect(second.raised).toBe(0)
    expect(nextDay.raised).toBe(3)
  })

  it('stops raising an item once it is actually resolved', async () => {
    const lease = await seedLease({
      estoppelConfirmedAt: new Date(),
      depositTransferStatus: 'NOT_TRANSFERRED',
    })
    const result = await raiseIntakeTasks(lease.id)
    // Only the condition baseline is left.
    expect(result.gaps).toEqual(['condition_baseline'])
    expect(result.raised).toBe(1)
  })
})

describe('outstandingIntakeGaps', () => {
  it('treats the NOT_APPLICABLE default as an unanswered question', async () => {
    // The single most dangerous default in this item: an inherited lease
    // whose deposit nobody ever asked about would otherwise look settled.
    const lease = await seedLease({ depositTransferStatus: 'NOT_APPLICABLE' })
    const gaps = await outstandingIntakeGaps(lease)
    expect(gaps.map((g) => g.gap)).toContain('deposit_transfer')
  })

  it('clears the condition-baseline gap once a photo is attached', async () => {
    const lease = await seedLease()
    expect(await hasConditionBaseline(lease.id)).toBe(false)

    const doc = await prisma.document.create({
      data: {
        propertyId,
        leaseId: lease.id,
        type: CONDITION_BASELINE_DOCUMENT_TYPE,
        fileName: 'kitchen.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `intake-test/${randomUUID()}`,
      },
    })
    documentIds.push(doc.id)

    expect(await hasConditionBaseline(lease.id)).toBe(true)
    const gaps = await outstandingIntakeGaps(lease)
    expect(gaps.map((g) => g.gap)).not.toContain('condition_baseline')
  })

  it('IGNORES a soft-deleted baseline photo', async () => {
    // DOC-05's 30-day undelete means a deleted document still has a row.
    // A baseline somebody deleted is a baseline that no longer exists.
    const lease = await seedLease()
    const doc = await prisma.document.create({
      data: {
        propertyId,
        leaseId: lease.id,
        type: CONDITION_BASELINE_DOCUMENT_TYPE,
        fileName: 'gone.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `intake-test/${randomUUID()}`,
        deletedAt: new Date(),
      },
    })
    documentIds.push(doc.id)
    expect(await hasConditionBaseline(lease.id)).toBe(false)
  })

  it('ignores a document of a different type on the same lease', async () => {
    const lease = await seedLease()
    const doc = await prisma.document.create({
      data: {
        propertyId,
        leaseId: lease.id,
        type: 'lease',
        fileName: 'signed-lease.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        storageKey: `intake-test/${randomUUID()}`,
      },
    })
    documentIds.push(doc.id)
    expect(await hasConditionBaseline(lease.id)).toBe(false)
  })
})

describe('listLeases', () => {
  it('puts running tenancies before drafts and ended ones', async () => {
    const scope = { propertyIds: [propertyId], legalEntityIds: [entityId] }
    const running = await seedLease()
    const ended = await prisma.lease.create({
      data: {
        propertyId,
        unitId,
        status: 'ENDED',
        startsOn: new Date('2030-01-01'), // newest by date, oldest by meaning
        rentCents: 100_000,
        isMonthToMonth: true,
      },
    })
    leaseIds.push(ended.id)

    const leases = await listLeases(scope as never)
    const runningIndex = leases.findIndex((l) => l.id === running.id)
    const endedIndex = leases.findIndex((l) => l.id === ended.id)
    // Despite the ended lease having the later start date - the ordering is
    // by meaning, not by date.
    expect(runningIndex).toBeLessThan(endedIndex)
  })

  it('returns nothing for an empty scope', async () => {
    expect(await listLeases({ propertyIds: [], legalEntityIds: [] } as never)).toEqual([])
  })
})
