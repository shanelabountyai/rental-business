import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation deposit-clearing-job.test.ts already
// relies on.
import './pre-move-out-scheduling-job.ts'

// The pre-move-out scheduling job (INSP-02, R-070): once a state grants the
// walkthrough right and a lease's own move-out date is known
// (`noticeEffectiveOn`), a PRE_MOVE_OUT inspection appears automatically,
// its items copied from the lease's own move-in inspection.

const STATE = 'XW' // not a real US state code, isolated from every other test's own state fixture (NY/TX/YY/ZZ).
const CHICAGO = 'America/Chicago'

let entityId: string
const propertyIds: string[] = []
const ruleIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const inspectionIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `PreMoveOut LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

afterEach(async () => {
  // NOT the property or the rule. `auditAsSystem` writes a real AuditLog row
  // with a FK to `propertyId` (unlike `entityId`, a plain string with no
  // constraint) every time the job schedules a walkthrough - once that
  // exists the property it names cannot be hard-deleted, the same "retire,
  // don't delete" fix auto-finalize-job.test.ts's own afterAll already
  // documents. Inspections, leases, units and tenants are all still
  // per-test-unique and safe to clear.
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspectionIds } } })
  await prisma.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
  await prisma.task.deleteMany({ where: { subjectId: { in: leaseIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  // NOT accumulated across tests: Postgres treats NULL as distinct from
  // NULL in a unique index, so `@@unique([state, jurisdiction, version])`
  // does NOT stop two rows sharing (state: 'XW', jurisdiction: null,
  // version: 1) from both existing - `rulesFor` then has more than one
  // candidate for the same state and the outcome depends on which the query
  // happens to return first. Deleted every test, so each test's own rule is
  // the only one on file when it runs.
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId: { in: propertyIds } } })
  inspectionIds.length = 0
  leaseIds.length = 0
  tenantIds.length = 0
  unitIds.length = 0
  ruleIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedProperty() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `PreMoveOut House-${unique}`,
      addressLine1: '1 Departure Dr',
      city: 'Anytown',
      state: STATE,
      postalCode: '00000',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

async function seedRule(overrides: {
  preMoveOutWalkthroughRequired: boolean
  preMoveOutWalkthroughDaysBefore?: number | null
}) {
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: STATE,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 0,
      lateFeeType: 'NONE',
      paymentAllocationOrder: [],
      preMoveOutWalkthroughRequired: overrides.preMoveOutWalkthroughRequired,
      preMoveOutWalkthroughDaysBefore: overrides.preMoveOutWalkthroughDaysBefore ?? null,
    },
  })
  ruleIds.push(rule.id)
  return rule
}

async function seedLeaseUnderNotice(propertyId: string, noticeEffectiveOn: string) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: 'Leaver', email: `pat-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2025-01-01T00:00:00Z'),
      rentCents: 150_000,
      noticeGivenAt: new Date('2026-08-01T00:00:00Z'),
      noticeGivenBy: 'TENANT',
      noticeEffectiveOn: new Date(`${noticeEffectiveOn}T00:00:00Z`),
    },
  })
  leaseIds.push(lease.id)
  return { unit, lease }
}

async function seedMoveIn(propertyId: string, unitId: string, leaseId: string) {
  const inspection = await prisma.inspection.create({
    data: {
      propertyId,
      unitId,
      leaseId,
      type: 'MOVE_IN',
      lockedAt: new Date('2025-01-01T12:00:00Z'),
      items: {
        create: [
          { room: 'Kitchen', item: 'Refrigerator', condition: 'GOOD', order: 0 },
          { room: 'Living room', item: 'Carpet', condition: 'NEW', order: 1 },
        ],
      },
    },
  })
  inspectionIds.push(inspection.id)
  return inspection
}

async function runAt(isoInstant: string, propertyId: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the pre-move-out scheduling job', () => {
  it('schedules a PRE_MOVE_OUT walkthrough, copied from move-in, when the right is granted', async () => {
    const property = await seedProperty()
    await seedRule({ preMoveOutWalkthroughRequired: true, preMoveOutWalkthroughDaysBefore: 14 })
    const { unit, lease } = await seedLeaseUnderNotice(property.id, '2026-09-30')
    const moveIn = await seedMoveIn(property.id, unit.id, lease.id)

    await runAt('2026-08-15T12:00:00Z', property.id)

    const created = await prisma.inspection.findFirst({
      where: { leaseId: lease.id, type: 'PRE_MOVE_OUT' },
      include: { items: { orderBy: { order: 'asc' } } },
    })
    inspectionIds.push(created!.id)
    expect(created).not.toBeNull()
    // 2026-09-30 minus 14 days.
    expect(created!.scheduledFor?.toISOString().slice(0, 10)).toBe('2026-09-16')
    expect(created!.items).toHaveLength(2)
    const moveInItems = await prisma.inspectionItem.findMany({ where: { inspectionId: moveIn.id } })
    expect(created!.items.map((i) => i.moveInItemId).sort()).toEqual(
      moveInItems.map((i) => i.id).sort(),
    )

    const task = await prisma.task.findFirst({
      where: { subjectId: lease.id, type: 'inspection.pre_move_out_scheduled' },
    })
    expect(task).not.toBeNull()
  })

  it('clamps into the past to today rather than never', async () => {
    const property = await seedProperty()
    await seedRule({ preMoveOutWalkthroughRequired: true, preMoveOutWalkthroughDaysBefore: 30 })
    // Only 5 days' notice - 30 days before move-out is already behind "today".
    const { unit, lease } = await seedLeaseUnderNotice(property.id, '2026-08-20')
    await seedMoveIn(property.id, unit.id, lease.id)

    await runAt('2026-08-15T12:00:00Z', property.id)

    const created = await prisma.inspection.findFirst({ where: { leaseId: lease.id, type: 'PRE_MOVE_OUT' } })
    inspectionIds.push(created!.id)
    expect(created!.scheduledFor?.toISOString().slice(0, 10)).toBe('2026-08-15')
  })

  it('schedules nothing where the state has not granted the right', async () => {
    const property = await seedProperty()
    await seedRule({ preMoveOutWalkthroughRequired: false })
    const { unit, lease } = await seedLeaseUnderNotice(property.id, '2026-09-30')
    await seedMoveIn(property.id, unit.id, lease.id)

    await runAt('2026-08-15T12:00:00Z', property.id)

    const created = await prisma.inspection.findFirst({ where: { leaseId: lease.id, type: 'PRE_MOVE_OUT' } })
    expect(created).toBeNull()
  })

  it('is idempotent - never schedules a second one on a later run', async () => {
    const property = await seedProperty()
    await seedRule({ preMoveOutWalkthroughRequired: true, preMoveOutWalkthroughDaysBefore: 14 })
    const { unit, lease } = await seedLeaseUnderNotice(property.id, '2026-09-30')
    await seedMoveIn(property.id, unit.id, lease.id)

    await runAt('2026-08-15T12:00:00Z', property.id)
    await runAt('2026-08-16T12:00:00Z', property.id)

    const all = await prisma.inspection.findMany({ where: { leaseId: lease.id, type: 'PRE_MOVE_OUT' } })
    all.forEach((i) => inspectionIds.push(i.id))
    expect(all).toHaveLength(1)
  })
})
