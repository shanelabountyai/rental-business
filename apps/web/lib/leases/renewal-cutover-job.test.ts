import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation `auto-make-ready.test.ts` already relies on.
import './renewal-cutover-job.ts'

// LEASE-09 (R-065): "Given a signed renewal ..., when effective, then the
// ledger updates with no manual edits." The cutover job activates a signed
// successor lease on ITS OWN effective date and ends the predecessor in the
// same transaction - proven here against directly-constructed rows (a
// COMPLETED LeaseEnvelope needs no real signer ceremony for THIS job's own
// logic, which only checks that one exists).

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
let staffId: string
let templateId: string
const unitIds: string[] = []
const leaseIds: string[] = []
const envelopeIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `cutover-${randomUUID().slice(0, 8)}`
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
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Test Staff' },
  })
  staffId = staff.id
  const template = await prisma.documentTemplate.create({
    data: { name: stamp, documentType: 'LEASE', body: 'x', createdByStaffId: staffId },
  })
  templateId = template.id
})

afterEach(async () => {
  await prisma.leaseEnvelope.deleteMany({ where: { id: { in: envelopeIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  // The cutover job's own provisionLeaseBilling() call opens a (simulated)
  // LeasePayer on activation - cleared before the lease it references.
  await prisma.leasePayer.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  envelopeIds.length = 0
  leaseIds.length = 0
  unitIds.length = 0
  tenantIds.length = 0
})

afterAll(async () => {
  await prisma.documentTemplate.delete({ where: { id: templateId } })
  const audited = await prisma.auditLog.count({ where: { propertyId } })
  if (audited > 0) {
    // This job's own audit trail (lease.renewed, billing.provisioned) carries
    // a real FK to this property - AuditLog is append-only, so the property
    // (and the entity holding it) cannot be hard-deleted, same as
    // auto-make-ready.test.ts's own identical lesson.
    await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
    await prisma.staffUser.update({ where: { id: staffId }, data: { active: false } })
    await prisma.legalEntity.update({ where: { id: entityId }, data: { active: false } })
  } else {
    await prisma.property.delete({ where: { id: propertyId } })
    await prisma.staffUser.delete({ where: { id: staffId } })
    await prisma.legalEntity.delete({ where: { id: entityId } })
  }
  await prisma.$disconnect()
})

async function makeUnit() {
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unitIds.length}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  return unit
}

/** A predecessor plus its already-signed successor, ready for cutover. */
async function makeRenewalPair(unitId: string, opts: { successorStartsOn: string; predecessorStatus?: string }) {
  const predecessor = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: (opts.predecessorStatus ?? 'ACTIVE') as never,
      startsOn: new Date('2026-01-01T00:00:00Z'),
      endsOn: new Date('2026-06-30T00:00:00Z'),
      rentCents: 150_000,
    },
  })
  leaseIds.push(predecessor.id)

  const successor = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'PENDING_SIGNATURE',
      origin: 'RENEWAL',
      renewedFromLeaseId: predecessor.id,
      startsOn: new Date(`${opts.successorStartsOn}T00:00:00Z`),
      endsOn: new Date('2027-06-30T00:00:00Z'),
      rentCents: 160_000,
    },
  })
  leaseIds.push(successor.id)
  const tenant = await prisma.tenant.create({ data: { firstName: 'Pat', lastName: 'Renter' } })
  tenantIds.push(tenant.id)
  await prisma.leaseTenant.create({ data: { leaseId: successor.id, tenantId: tenant.id, isPrimary: true } })

  const envelope = await prisma.leaseEnvelope.create({
    data: { leaseId: successor.id, templateId, status: 'COMPLETED', completedAt: new Date() },
  })
  envelopeIds.push(envelope.id)

  return { predecessor, successor }
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the renewal-cutover job', () => {
  it('activates a signed successor and ends the predecessor on the effective date', async () => {
    const unit = await makeUnit()
    const { predecessor, successor } = await makeRenewalPair(unit.id, { successorStartsOn: '2026-07-01' })

    await runAt('2026-07-02T09:00:00Z')

    const updatedSuccessor = await prisma.lease.findUniqueOrThrow({ where: { id: successor.id } })
    expect(updatedSuccessor.status).toBe('ACTIVE')
    expect(updatedSuccessor.activatedAt).not.toBeNull()

    const updatedPredecessor = await prisma.lease.findUniqueOrThrow({ where: { id: predecessor.id } })
    expect(updatedPredecessor.status).toBe('ENDED')
    // The tenant never left - a real move-out timestamp would be wrong here.
    expect(updatedPredecessor.moveOutAt).toBeNull()
  })

  it('leaves the unit OCCUPIED, never MAKE_READY - the tenant is continuing, not leaving', async () => {
    const unit = await makeUnit()
    await makeRenewalPair(unit.id, { successorStartsOn: '2026-07-01' })

    await runAt('2026-07-02T09:00:00Z')

    const updatedUnit = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updatedUnit.status).toBe('OCCUPIED')
  })

  it('does not activate before the effective date arrives', async () => {
    const unit = await makeUnit()
    const { successor } = await makeRenewalPair(unit.id, { successorStartsOn: '2026-09-01' })

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: successor.id } })
    expect(updated.status).toBe('PENDING_SIGNATURE')
  })

  it('skips a successor whose predecessor is no longer the live tenancy', async () => {
    const unit = await makeUnit()
    const { successor } = await makeRenewalPair(unit.id, {
      successorStartsOn: '2026-07-01',
      predecessorStatus: 'TERMINATED',
    })

    await runAt('2026-07-02T09:00:00Z')

    const updated = await prisma.lease.findUniqueOrThrow({ where: { id: successor.id } })
    expect(updated.status).toBe('PENDING_SIGNATURE')
  })

  it('writes a lease.renewed audit entry naming the predecessor', async () => {
    const unit = await makeUnit()
    const { predecessor, successor } = await makeRenewalPair(unit.id, { successorStartsOn: '2026-07-01' })

    await runAt('2026-07-02T09:00:00Z')

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'lease.renewed', entityId: successor.id },
    })
    expect(entry).not.toBeNull()
    expect(entry?.after).toMatchObject({ renewedFromLeaseId: predecessor.id })
  })
})
