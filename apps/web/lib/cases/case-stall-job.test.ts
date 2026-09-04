import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation every other job test in this codebase
// relies on.
import './case-stall-job.ts'

// The stall sweep for the five case types review §7 found with none (D-9).
// NOW = 2026-09-01T12:00:00Z, noon UTC so America/Chicago never crosses a
// calendar-day boundary from the conversion itself (the `@db.Date` /
// timestamp trap CLAUDE.md warns about) - property-local today is
// 2026-09-01 throughout.

const NOW = '2026-09-01T12:00:00Z'
const STATE = 'QZ' // isolated from every other test's own state fixture (TX/ZZ/XY/ZY/XW/NY/YQ).
const CHICAGO = 'America/Chicago'

let entityId: string
let propertyId: string
let unitId: string
let leaseId: string
let staffId: string
let tenantId: string
let policyId: string
let listingId: string
let applicationId: string
let ruleId: string

const accommodationIds: string[] = []
const abandonmentCaseIds: string[] = []
const violationCaseIds: string[] = []
const claimIds: string[] = []
const partyChangeIds: string[] = []
const incomingTenantIds: string[] = []
const applicantIds: string[] = []

beforeAll(async () => {
  const stamp = `stall-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '9 Stalled Way',
      city: 'Houston',
      state: STATE,
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Resident-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: { propertyId, unitId, status: 'ACTIVE', startsOn: new Date('2026-01-01'), rentCents: 150_000 },
  })
  leaseId = lease.id
  await prisma.leaseTenant.create({ data: { leaseId, tenantId, isPrimary: true } })
  const staff = await prisma.staffUser.create({
    data: { email: `stall-${randomUUID()}@example.test`, name: 'Case Handler' },
  })
  staffId = staff.id
  const policy = await prisma.insurancePolicy.create({
    data: { propertyId, carrier: 'Test Mutual', renewsOn: new Date('2027-01-01') },
  })
  policyId = policy.id
  const listing = await prisma.listing.create({
    data: {
      propertyId,
      unitId,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingId = listing.id
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: 'Pat',
      lastName: `Prospect-${randomUUID().slice(0, 6)}`,
      email: `pat-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
      status: 'APPLIED',
    },
  })
  const application = await prisma.application.create({
    data: { propertyId, listingId, prospectId: prospect.id, completedAt: new Date() },
  })
  applicationId = application.id
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: STATE,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 0,
      lateFeeType: 'NONE',
      paymentAllocationOrder: [],
      leaseViolationCureDays: 5,
    },
  })
  ruleId = rule.id
})

afterEach(async () => {
  const subjectIds = [
    ...accommodationIds,
    ...abandonmentCaseIds,
    ...violationCaseIds,
    ...claimIds,
    ...partyChangeIds,
  ]
  await prisma.task.deleteMany({ where: { subjectId: { in: subjectIds } } })
  await prisma.accommodationRequest.deleteMany({ where: { id: { in: accommodationIds } } })
  await prisma.abandonmentCase.deleteMany({ where: { id: { in: abandonmentCaseIds } } })
  // Notice is append-only by trigger (R-161) - it cannot be deleted, and
  // its Restrict FK means a ViolationCase a Notice was filed under can't be
  // either. Left as debris, same as this file already leaves its property/
  // lease/staff/tenant fixtures - every test's ids are freshly randomized,
  // so nothing collides.
  await prisma.insuranceClaim.deleteMany({ where: { id: { in: claimIds } } })
  await prisma.leasePartyChange.deleteMany({ where: { id: { in: partyChangeIds } } })
  await prisma.screeningReport.deleteMany({ where: { applicantId: { in: applicantIds } } })
  await prisma.applicant.deleteMany({ where: { id: { in: applicantIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: incomingTenantIds } }, data: { active: false } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  accommodationIds.length = 0
  abandonmentCaseIds.length = 0
  violationCaseIds.length = 0
  claimIds.length = 0
  partyChangeIds.length = 0
  incomingTenantIds.length = 0
  applicantIds.length = 0
})

afterAll(async () => {
  await prisma.insuranceClaim.deleteMany({ where: { policyId } })
  await prisma.insurancePolicy.deleteMany({ where: { id: policyId } })
  await prisma.application.deleteMany({ where: { id: applicationId } })
  await prisma.prospect.deleteMany({ where: { listingId } })
  await prisma.listing.deleteMany({ where: { id: listingId } })
  await prisma.jurisdictionRule.deleteMany({ where: { id: ruleId } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId } })
  await prisma.lease.updateMany({ where: { id: leaseId }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function run() {
  return runDueJobs(new Date(NOW), { propertyIds: [propertyId] })
}

describe('accommodation response clock', () => {
  it('escalates to EMERGENCY once the ten-day FHA clock is overdue and undecided', async () => {
    const overdue = await prisma.accommodationRequest.create({
      data: {
        propertyId,
        leaseId,
        kind: 'ASSISTANCE_ANIMAL',
        requestText: 'A cat, for anxiety.',
        receivedOn: new Date('2026-08-20'), // 12 days before NOW
      },
    })
    const fresh = await prisma.accommodationRequest.create({
      data: {
        propertyId,
        leaseId,
        kind: 'ASSISTANCE_ANIMAL',
        requestText: 'A dog, for anxiety.',
        receivedOn: new Date('2026-08-28'), // 4 days before NOW
      },
    })
    accommodationIds.push(overdue.id, fresh.id)

    await run()

    const task = await prisma.task.findFirst({
      where: { type: 'accommodation.response_overdue', subjectId: overdue.id },
    })
    expect(task?.priority).toBe('EMERGENCY')
    expect(
      await prisma.task.findFirst({ where: { type: 'accommodation.response_overdue', subjectId: fresh.id } }),
    ).toBeNull()
  })
})

describe('abandonment attempts gone quiet', () => {
  it('flags a case with nothing logged in two weeks', async () => {
    const quiet = await prisma.abandonmentCase.create({
      data: { propertyId, unitId, leaseId, openedByStaffId: staffId, openedAt: new Date('2026-08-01T12:00:00Z') },
    })
    const active = await prisma.abandonmentCase.create({
      data: { propertyId, unitId, leaseId, openedByStaffId: staffId, openedAt: new Date('2026-08-25T12:00:00Z') },
    })
    abandonmentCaseIds.push(quiet.id, active.id)

    await run()

    expect(
      await prisma.task.findFirst({ where: { type: 'abandonment.case_stalled', subjectId: quiet.id } }),
    ).not.toBeNull()
    expect(
      await prisma.task.findFirst({ where: { type: 'abandonment.case_stalled', subjectId: active.id } }),
    ).toBeNull()
  })
})

describe('violation cure notice expired, unserved', () => {
  it('flags a notice that has sat unserved past the state cure period', async () => {
    const stalledCase = await prisma.violationCase.create({
      data: { propertyId, unitId, leaseId, kind: 'UNAUTHORIZED_OCCUPANT', openedByStaffId: staffId },
    })
    const freshCase = await prisma.violationCase.create({
      data: { propertyId, unitId, leaseId, kind: 'UNAUTHORIZED_OCCUPANT', openedByStaffId: staffId },
    })
    violationCaseIds.push(stalledCase.id, freshCase.id)
    await prisma.notice.create({
      data: {
        propertyId,
        leaseId,
        type: 'LEASE_VIOLATION',
        addressOfRecord: '9 Stalled Way',
        violationCaseId: stalledCase.id,
        generatedAt: new Date('2026-08-25T12:00:00Z'), // 7 days before NOW, > 5-day rule
      },
    })
    await prisma.notice.create({
      data: {
        propertyId,
        leaseId,
        type: 'LEASE_VIOLATION',
        addressOfRecord: '9 Stalled Way',
        violationCaseId: freshCase.id,
        generatedAt: new Date('2026-08-30T12:00:00Z'), // 2 days before NOW, < 5-day rule
      },
    })
    await run()

    expect(
      await prisma.task.findFirst({ where: { type: 'violation.cure_unserved_stalled', subjectId: stalledCase.id } }),
    ).not.toBeNull()
    expect(
      await prisma.task.findFirst({ where: { type: 'violation.cure_unserved_stalled', subjectId: freshCase.id } }),
    ).toBeNull()
  })
})

describe('insurance claim silent past the mitigation target', () => {
  it('flags a WATER claim with nothing started 30 hours after the loss', async () => {
    const silent = await prisma.insuranceClaim.create({
      data: {
        propertyId,
        policyId,
        cause: 'WATER',
        description: 'Burst supply line under the kitchen sink.',
        incidentAt: new Date('2026-08-31T06:00:00Z'), // 30h before NOW
        openedByStaffId: staffId,
      },
    })
    const mitigated = await prisma.insuranceClaim.create({
      data: {
        propertyId,
        policyId,
        cause: 'WATER',
        description: 'Roof leak after a storm.',
        incidentAt: new Date('2026-08-31T06:00:00Z'),
        mitigationStartedAt: new Date('2026-08-31T08:00:00Z'),
        openedByStaffId: staffId,
      },
    })
    claimIds.push(silent.id, mitigated.id)

    await run()

    expect(
      await prisma.task.findFirst({ where: { type: 'insurance_claim.mitigation_stalled', subjectId: silent.id } }),
    ).not.toBeNull()
    expect(
      await prisma.task.findFirst({ where: { type: 'insurance_claim.mitigation_stalled', subjectId: mitigated.id } }),
    ).toBeNull()
  })
})

describe('party-change amendment unsigned with an unscreened occupant', () => {
  async function seedIncomingParty(decision: string | null) {
    const incomingTenant = await prisma.tenant.create({
      data: { firstName: 'Alex', lastName: `Incoming-${randomUUID().slice(0, 6)}` },
    })
    incomingTenantIds.push(incomingTenant.id)
    const applicant = await prisma.applicant.create({
      data: { applicationId, isLead: false, firstName: 'Alex', lastName: incomingTenant.lastName },
    })
    applicantIds.push(applicant.id)
    await prisma.screeningReport.create({
      data: {
        applicantId: applicant.id,
        providerId: 'test-provider',
        status: 'COMPLETE',
        criteriaVersion: 1,
        decision,
      },
    })
    const change = await prisma.leasePartyChange.create({
      data: {
        leaseId,
        status: 'PENDING_SIGNATURE',
        effectiveOn: new Date('2026-09-15'),
        reason: 'Roommate replacement.',
        createdByStaffId: staffId,
        createdAt: new Date('2026-08-28T12:00:00Z'), // 4 days before NOW, > 3-day threshold
      },
    })
    partyChangeIds.push(change.id)
    await prisma.leasePartyChangeParty.create({
      data: { changeId: change.id, direction: 'INCOMING', tenantId: incomingTenant.id, applicantId: applicant.id },
    })
    return change
  }

  it('flags an amendment sitting unsigned with the incoming occupant still unscreened', async () => {
    const unscreened = await seedIncomingParty(null)
    const screened = await seedIncomingParty('APPROVED')

    await run()

    expect(
      await prisma.task.findFirst({
        where: { type: 'party_change.unsigned_unscreened_stalled', subjectId: unscreened.id },
      }),
    ).not.toBeNull()
    expect(
      await prisma.task.findFirst({
        where: { type: 'party_change.unsigned_unscreened_stalled', subjectId: screened.id },
      }),
    ).toBeNull()
  })
})
