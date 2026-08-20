import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation renter-insurance-job.test.ts already
// relies on.
import './auto-finalize-job.ts'

// Auto-finalize (INSP-01, R-068 phase 2): a performed-but-unsigned report
// locks itself once the 3-day signature window elapses.

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const inspectionIds: string[] = []

beforeAll(async () => {
  const stamp = `autofinalize-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
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
  await prisma.task.deleteMany({ where: { propertyId } })
  await prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspectionIds } } })
  await prisma.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  inspectionIds.length = 0
  leaseIds.length = 0
  tenantIds.length = 0
  unitIds.length = 0
})

afterAll(async () => {
  // AuditLog is append-only by trigger, and this job writes real entries -
  // once one exists the property it names cannot be hard-deleted. Same
  // "retire, don't delete" fix every other evidence-writing test suite in
  // this codebase reaches for.
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function makeLeaseAndTenant(unique: string) {
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: 'Renter', email: `pat-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return { unit, tenant, lease }
}

async function makeInspection(
  unitId: string,
  leaseId: string,
  overrides: Partial<{ performedAt: Date; tenantSignedAt: Date; lockedAt: Date }> = {},
) {
  const inspection = await prisma.inspection.create({
    data: {
      propertyId,
      unitId,
      leaseId,
      type: 'PERIODIC',
      ...overrides,
    },
  })
  inspectionIds.push(inspection.id)
  return inspection
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the inspection auto-finalize job', () => {
  it('locks a report performed more than 3 days ago with no signature', async () => {
    const { unit, lease } = await makeLeaseAndTenant('a')
    const inspection = await makeInspection(unit.id, lease.id, {
      performedAt: new Date('2026-07-01T12:00:00Z'),
    })

    await runAt('2026-07-05T12:00:00Z') // 4 days later

    const after = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
    expect(after.lockedAt).not.toBeNull()

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'inspection.locked', entityId: inspection.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
    expect(audited?.after).toMatchObject({ autoFinalized: true })
  })

  it('leaves a report alone while it is still inside the signature window', async () => {
    const { unit, lease } = await makeLeaseAndTenant('b')
    const inspection = await makeInspection(unit.id, lease.id, {
      performedAt: new Date('2026-07-04T12:00:00Z'),
    })

    await runAt('2026-07-05T12:00:00Z') // 1 day later

    const after = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
    expect(after.lockedAt).toBeNull()
  })

  it('never touches a report that already has a signature', async () => {
    const { unit, lease } = await makeLeaseAndTenant('c')
    const inspection = await makeInspection(unit.id, lease.id, {
      performedAt: new Date('2026-07-01T12:00:00Z'),
      tenantSignedAt: new Date('2026-07-01T13:00:00Z'),
      lockedAt: new Date('2026-07-01T13:00:00Z'),
    })

    await runAt('2026-07-10T12:00:00Z')

    const after = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
    expect(after.lockedAt).toEqual(inspection.lockedAt)
  })
})

describe('the move-in walkthrough escalation job (INSP-05, R-074)', () => {
  it('raises a staff Task and reminds the tenant once the window elapses unwalked', async () => {
    const { unit, lease } = await makeLeaseAndTenant('d')
    const inspection = await prisma.inspection.create({
      data: {
        propertyId,
        unitId: unit.id,
        leaseId: lease.id,
        type: 'MOVE_IN',
        selfGuided: true,
        createdAt: new Date('2026-07-01T12:00:00Z'),
      },
    })
    inspectionIds.push(inspection.id)

    await runAt('2026-07-09T12:00:00Z') // 8 days later, past the 7-day window

    // Never locked - a blank report is not evidence of anything, so this
    // job escalates rather than finalizing.
    const after = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
    expect(after.performedAt).toBeNull()
    expect(after.lockedAt).toBeNull()

    const task = await prisma.task.findFirst({
      where: { type: 'inspection.move_in_overdue', subjectId: inspection.id },
    })
    expect(task).not.toBeNull()
  })

  it('leaves an unwalked report alone while still inside the window', async () => {
    const { unit, lease } = await makeLeaseAndTenant('e')
    const inspection = await prisma.inspection.create({
      data: {
        propertyId,
        unitId: unit.id,
        leaseId: lease.id,
        type: 'MOVE_IN',
        selfGuided: true,
        createdAt: new Date('2026-07-04T12:00:00Z'),
      },
    })
    inspectionIds.push(inspection.id)

    await runAt('2026-07-05T12:00:00Z') // 1 day later

    const task = await prisma.task.findFirst({
      where: { type: 'inspection.move_in_overdue', subjectId: inspection.id },
    })
    expect(task).toBeNull()
  })

  it('never escalates a traditional staff-performed MOVE_IN inspection', async () => {
    const { unit, lease } = await makeLeaseAndTenant('f')
    const inspection = await prisma.inspection.create({
      data: {
        propertyId,
        unitId: unit.id,
        leaseId: lease.id,
        type: 'MOVE_IN',
        selfGuided: false,
        createdAt: new Date('2026-07-01T12:00:00Z'),
      },
    })
    inspectionIds.push(inspection.id)

    await runAt('2026-07-09T12:00:00Z')

    const task = await prisma.task.findFirst({
      where: { type: 'inspection.move_in_overdue', subjectId: inspection.id },
    })
    expect(task).toBeNull()
  })

  it('is idempotent - running the job again the next day raises only one Task', async () => {
    const { unit, lease } = await makeLeaseAndTenant('g')
    const inspection = await prisma.inspection.create({
      data: {
        propertyId,
        unitId: unit.id,
        leaseId: lease.id,
        type: 'MOVE_IN',
        selfGuided: true,
        createdAt: new Date('2026-07-01T12:00:00Z'),
      },
    })
    inspectionIds.push(inspection.id)

    // Both runs are past the deadline, on different business dates - the
    // job's own createTask call is keyed on the FIXED due date, not "today",
    // which is what makes a second run a no-op instead of a second Task.
    await runAt('2026-07-09T12:00:00Z')
    await runAt('2026-07-10T12:00:00Z')

    const tasks = await prisma.task.findMany({
      where: { type: 'inspection.move_in_overdue', subjectId: inspection.id },
    })
    expect(tasks).toHaveLength(1)
  })
})
