import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import {
  currentScreeningCriteria,
  orderScreeningForApplicant,
  orderScreeningForApplication,
  outOfOrderApplicationIds,
} from './order.ts'
import { screeningForApplication } from './queries.ts'
import { simulatedScreeningFacts } from './simulated-adapter.ts'

// The database half of LEASE-04 (R-060) - everything EXCEPT
// recordScreeningDecision (staff-actions.ts, session-dependent via
// requirePermission/audit()), which is e2e-only, the same wall
// applications.test.ts and prospects.test.ts already draw for the
// identical reason.

function scopeOf(propertyIds: string[]): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: false,
  }
}

let entityId: string
let propertyId: string
let unitId: string
let listingId: string
const prospectIds: string[] = []
const applicationIds: string[] = []

beforeAll(async () => {
  const stamp = `screening-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '77 Screening Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  unitId = unit.id
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
})

afterAll(async () => {
  await prisma.screeningReport.deleteMany({
    where: { applicant: { application: { propertyId } } },
  })
  await prisma.applicant.deleteMany({ where: { application: { propertyId } } })
  await prisma.application.deleteMany({ where: { id: { in: applicationIds } } })
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listing.deleteMany({ where: { id: listingId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedApplication(status: 'APPLIED' | 'INQUIRY' = 'APPLIED') {
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: 'Riley',
      lastName: `Fields-${randomUUID().slice(0, 6)}`,
      email: `riley-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
      status,
    },
  })
  prospectIds.push(prospect.id)

  const application = await prisma.application.create({
    data: { propertyId, listingId, prospectId: prospect.id, completedAt: new Date() },
  })
  applicationIds.push(application.id)

  const lead = await prisma.applicant.create({
    data: {
      applicationId: application.id,
      isLead: true,
      firstName: prospect.firstName,
      lastName: prospect.lastName,
      monthlyIncomeCents: 600_000,
    },
  })

  return { prospect, application, lead }
}

describe('currentScreeningCriteria', () => {
  it('returns the seeded, currently-effective version', async () => {
    const criteria = await currentScreeningCriteria()
    expect(criteria.version).toBeGreaterThanOrEqual(1)
    expect(criteria.effectiveTo).toBeNull()
  })
})

describe('orderScreeningForApplicant', () => {
  it('creates a report matching the simulated adapter, deterministic from the applicant id', async () => {
    const { lead } = await seedApplication()
    await orderScreeningForApplicant({ id: lead.id, applicationId: lead.applicationId })

    const report = await prisma.screeningReport.findUniqueOrThrow({
      where: { applicantId: lead.id },
    })
    expect(report.status).toBe('COMPLETE')
    const expected = simulatedScreeningFacts(lead.id)
    expect(report.creditScore).toBe(expected.creditScore)
    expect(report.evictionRecordFound).toBe(expected.evictionRecordFound)
    expect(report.criminalRecordFound).toBe(expected.criminalRecordFound)
  })

  it('is idempotent - a second call for the same applicant creates nothing new', async () => {
    const { lead } = await seedApplication()
    await orderScreeningForApplicant({ id: lead.id, applicationId: lead.applicationId })
    await orderScreeningForApplicant({ id: lead.id, applicationId: lead.applicationId })

    const reports = await prisma.screeningReport.findMany({ where: { applicantId: lead.id } })
    expect(reports).toHaveLength(1)
  })

  it('logs screening.ordered attributed to SYSTEM', async () => {
    const { lead } = await seedApplication()
    await orderScreeningForApplicant({ id: lead.id, applicationId: lead.applicationId })

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'screening.ordered', entityId: lead.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
  })
})

describe('orderScreeningForApplication', () => {
  it('advances the Prospect from APPLIED to SCREENED once every applicant completes', async () => {
    const { prospect, application } = await seedApplication('APPLIED')
    await orderScreeningForApplication(application.id)

    const updated = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
    expect(updated.status).toBe('SCREENED')
  })

  it('never overwrites a stage staff already set past APPLIED', async () => {
    const { prospect, application } = await seedApplication('APPLIED')
    // Staff moved this ahead by hand before the (re-run, idempotent) call.
    await prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'SIGNED' } })
    await orderScreeningForApplication(application.id)

    const updated = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
    expect(updated.status).toBe('SIGNED')
  })
})

describe('outOfOrderApplicationIds', () => {
  it('flags an earlier-completed sibling on the same listing with no decision yet', async () => {
    const { application: earlier } = await seedApplication()
    const { application: later } = await seedApplication()
    // Force a real ordering gap between the two completedAt timestamps.
    await prisma.application.update({
      where: { id: earlier.id },
      data: { completedAt: new Date(Date.now() - 60_000) },
    })

    const ids = await outOfOrderApplicationIds({
      id: later.id,
      listingId: later.listingId,
      completedAt: later.completedAt,
    })
    expect(ids).toContain(earlier.id)
  })

  it('is empty once nothing else is undecided', async () => {
    const { application: only } = await seedApplication()
    const ids = await outOfOrderApplicationIds({
      id: only.id,
      listingId: only.listingId,
      completedAt: only.completedAt,
    })
    expect(ids).not.toContain(only.id)
  })
})

describe('screeningForApplication', () => {
  it('scopes to the property and evaluates criteria alongside the report', async () => {
    const { application, lead } = await seedApplication()
    await orderScreeningForApplicant({ id: lead.id, applicationId: application.id })

    const result = await screeningForApplication(application.id, scopeOf([propertyId]))
    expect(result).not.toBeNull()
    expect(result!.applicants).toHaveLength(1)
    const applicant = result!.applicants[0]!
    expect(applicant.reportStatus).toBe('COMPLETE')
    expect(applicant.criteria.map((c) => c.key).sort()).toEqual([
      'credit',
      'criminal',
      'eviction',
      'income',
    ])
  })

  it('returns null outside scope', async () => {
    const { application } = await seedApplication()
    const result = await screeningForApplication(application.id, scopeOf(['some-other-property']))
    expect(result).toBeNull()
  })
})
