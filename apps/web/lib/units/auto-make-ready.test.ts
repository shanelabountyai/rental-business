import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS (Vitest isolates modules per test file, so this does not
// collide with jobs.test.ts's synthetic test jobs in R-006's own suite).
import './auto-make-ready.ts'

// PROP-02: "Given a unit whose lease ends without renewal, when the end date
// passes, then unit status auto-transitions to make-ready." Tested the same
// way R-006 tested its own job runner - against directly-seeded rows, since
// R-033 has not built lease creation yet.

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const unitIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `automr-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterEach(async () => {
  // TurnoverProject.leaseId is RESTRICT (R-072) - a real transition in this
  // file now starts one, same as R-071's deposit and R-011's task before it.
  await prisma.turnoverProject.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  // eventConsumption before outboxEvent: the FK is RESTRICT, and this
  // property's unit.became_make_ready event is real enough for R-016's own
  // registered consumer to have actually processed it, leaving a row that
  // references the OutboxEvent this would otherwise try to delete first.
  // The same order documents.spec.ts, jurisdiction.spec.ts and emergency.spec.ts
  // already use for exactly this reason.
  await prisma.eventConsumption.deleteMany({ where: { event: { propertyId } } })
  await prisma.outboxEvent.deleteMany({ where: { propertyId } })
  leaseIds.length = 0
  unitIds.length = 0
})

afterAll(async () => {
  // This test's own audit entries (from the job's recordAudit calls) carry a
  // real foreign key to this property (AuditLog.propertyId), and AuditLog is
  // append-only - so the property cannot be hard-deleted, same as R-005's
  // staff-user lesson and R-008's property lesson, now hit directly by a
  // job's own audit trail rather than a UI action's. Deactivate instead.
  const audited = await prisma.auditLog.count({ where: { propertyId } })
  if (audited > 0) {
    await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  } else {
    await prisma.property.delete({ where: { id: propertyId } })
    await prisma.legalEntity.delete({ where: { id: entityId } })
  }
  await prisma.$disconnect()
})

async function makeUnit(status: 'OCCUPIED' | 'VACANT' | 'MAKE_READY' | 'DOWN') {
  const unit = await prisma.unit.create({
    data: { propertyId, name: `Unit-${unitIds.length}`, status },
  })
  unitIds.push(unit.id)
  return unit
}

async function makeLease(
  unitId: string,
  overrides: Partial<{
    status: 'DRAFT' | 'PENDING_SIGNATURE' | 'ACTIVE' | 'MONTH_TO_MONTH' | 'ENDED' | 'TERMINATED'
    startsOn: string
    endsOn: string | null
  }> = {},
) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: overrides.status ?? 'ACTIVE',
      startsOn: new Date(`${overrides.startsOn ?? '2026-01-01'}T00:00:00Z`),
      endsOn: overrides.endsOn === undefined
        ? new Date('2026-06-30T00:00:00Z')
        : overrides.endsOn
          ? new Date(`${overrides.endsOn}T00:00:00Z`)
          : null,
      rentCents: 185_000,
    },
  })
  leaseIds.push(lease.id)
  return lease
}

/** Runs the job at a fixed instant, scoped to only this file's property. */
async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the auto-make-ready job', () => {
  it('flips an occupied unit to MAKE_READY once its lease has ended with no renewal', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-06-30' })

    // 07:00 UTC = 02:00 CDT, past the job's 03:00 target the FOLLOWING day.
    await runAt('2026-07-02T08:00:00Z')

    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updated.status).toBe('MAKE_READY')
  })

  it('leaves the unit alone while the lease is still in its term', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-12-31' })

    await runAt('2026-07-02T08:00:00Z')

    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updated.status).toBe('OCCUPIED')
  })

  // The exact acceptance criterion: "ends WITHOUT renewal". A successor lease
  // starting on/after the end date means the unit is not going empty.
  it('does not transition when a successor lease already exists', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-06-30' })
    await makeLease(unit.id, { status: 'ACTIVE', startsOn: '2026-07-01', endsOn: null })

    await runAt('2026-07-02T08:00:00Z')

    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updated.status).toBe('OCCUPIED')
  })

  it('does not fire the day the lease ends, only once it has actually passed', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-07-02' })

    // Same business date as endsOn - the lease's last day is not yet over.
    await runAt('2026-07-02T08:00:00Z')

    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updated.status).toBe('OCCUPIED')
  })

  it('leaves a unit that is not OCCUPIED untouched, even with an ended lease', async () => {
    const unit = await makeUnit('DOWN')
    await makeLease(unit.id, { endsOn: '2026-06-30' })

    await runAt('2026-07-02T08:00:00Z')

    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updated.status).toBe('DOWN')
  })

  it('ignores a lease that is already ENDED or TERMINATED in our records', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { status: 'ENDED', endsOn: '2026-06-30' })

    await runAt('2026-07-02T08:00:00Z')

    // Not our job to touch here - status ENDED means something already
    // closed this lease out, and the unit's current status is none of this
    // job's business at that point.
    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updated.status).toBe('OCCUPIED')
  })

  it('runs once per property per local day, like every R-006 job', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-06-30' })

    await runAt('2026-07-02T08:00:00Z')
    await runAt('2026-07-02T09:00:00Z')
    await runAt('2026-07-02T12:00:00Z')

    const runs = await prisma.jobRun.count({
      where: { jobType: 'unit.auto_make_ready', propertyId },
    })
    expect(runs).toBe(1)
  })

  it('records what it did in the JobRun result', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-06-30' })

    await runAt('2026-07-02T08:00:00Z')

    const run = await prisma.jobRun.findFirstOrThrow({
      where: { jobType: 'unit.auto_make_ready', propertyId },
    })
    expect(run.result).toMatchObject({ checked: 1, transitioned: 1 })
  })

  it('emits unit.became_make_ready and an audit entry for a real transition', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-06-30' })

    await runAt('2026-07-02T08:00:00Z')

    const event = await prisma.outboxEvent.findFirst({
      where: { type: 'unit.became_make_ready', aggregateId: unit.id },
    })
    expect(event).not.toBeNull()

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'unit.auto_made_ready', entityId: unit.id },
    })
    expect(entry).not.toBeNull()
    expect(entry?.actorType).toBe('SYSTEM')
    expect(entry?.before).toMatchObject({ status: 'OCCUPIED' })
    expect(entry?.after).toMatchObject({ status: 'MAKE_READY' })
  })

  it('stamps moveOutAt from endsOn and starts a turnover project (LEASE-12, R-072)', async () => {
    const unit = await makeUnit('OCCUPIED')
    const lease = await makeLease(unit.id, { endsOn: '2026-06-30' })

    await runAt('2026-07-02T08:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })
    expect(updated.moveOutAt?.toISOString()).toBe(lease.endsOn?.toISOString())

    const project = await prisma.turnoverProject.findUnique({ where: { leaseId: lease.id } })
    expect(project).not.toBeNull()
    expect(project?.unitId).toBe(unit.id)
  })

  it('emits nothing when no transition happens', async () => {
    const unit = await makeUnit('OCCUPIED')
    await makeLease(unit.id, { endsOn: '2026-12-31' })

    await runAt('2026-07-02T08:00:00Z')

    expect(
      await prisma.outboxEvent.count({
        where: { type: 'unit.became_make_ready', aggregateId: unit.id },
      }),
    ).toBe(0)
  })
})
