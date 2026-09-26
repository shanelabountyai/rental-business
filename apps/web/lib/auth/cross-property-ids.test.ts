import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildPartyChange, loadLeaseForPartyChange } from '@/lib/leases/party-change-builder.ts'
import { updateUnit } from '@/lib/units/actions.ts'

// SEC-09 / SEC-10 (K4 sweep, 2026-09-26): an action checked the permission on
// the record named in the URL, then trusted a SECOND id off the form. A
// manager of house A, holding nothing on house B, could name B's rows.
//
// Two houses on two entities; the actor owns A only. Session mocked, the
// grant and the RBAC decision real - same seam as chargeback-actions.test.ts.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const session = vi.hoisted(() => ({ staffId: '' }))
vi.mock('@/auth.ts', () => ({
  auth: async () => ({ principal: { kind: 'staff', id: session.staffId, mfaVerified: true } }),
}))

const unique = randomUUID().slice(0, 8)
const entityIds: string[] = []
const propertyIds: string[] = []

async function house(label: string) {
  const entity = await prisma.legalEntity.create({ data: { name: `${label}-${unique}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${label} House-${unique}`,
      addressLine1: '1 Scope St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT', marketRentCents: 150_000 },
  })
  const listing = await prisma.listing.create({
    data: { propertyId: property.id, unitId: unit.id, status: 'DRAFT', rentCents: 150_000, availableOn: new Date('2026-01-01') },
  })
  const prospect = await prisma.prospect.create({
    data: { propertyId: property.id, listingId: listing.id, firstName: 'Pat', lastName: `${label}-${unique}`, email: `pat-${label}-${unique}@example.test`, source: 'WALK_IN' },
  })
  const application = await prisma.application.create({
    data: { propertyId: property.id, listingId: listing.id, prospectId: prospect.id },
  })
  const applicant = await prisma.applicant.create({
    data: { applicationId: application.id, isLead: true, firstName: 'Pat', lastName: `${label}-${unique}` },
  })
  return { property, unit, applicant }
}

let a: Awaited<ReturnType<typeof house>>
let b: Awaited<ReturnType<typeof house>>
let leaseId: string

beforeAll(async () => {
  a = await house('A')
  b = await house('B')
  const lease = await prisma.lease.create({
    data: {
      propertyId: a.property.id,
      unitId: a.unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  leaseId = lease.id
  const staff = await prisma.staffUser.create({
    data: { email: `sec-scope-${unique}@example.test`, name: 'Scoped Owner' },
  })
  session.staffId = staff.id
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: owner.id, propertyId: a.property.id },
  })
})

afterAll(async () => {
  await prisma.staffUser.updateMany({ where: { id: session.staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

describe('SEC-09: party change takes only applicants from the lease property', () => {
  // An empty effective date fails the assessment AFTER the applicant load, so
  // neither case writes anything: the refusal text tells them apart.
  async function attempt(applicantId: string) {
    const { lease, actor } = await loadLeaseForPartyChange(leaseId)
    return buildPartyChange({
      lease,
      actorId: actor.id,
      outgoingTenantIds: [],
      incomingApplicantIds: [applicantId],
      effectiveOn: '',
      reason: '',
      acknowledgedWarnings: false,
      unsigned: null,
    })
  }

  it("treats another property's applicant as not found", async () => {
    expect((await attempt(b.applicant.id)).error).toBe('One of the applicants named could not be found.')
  })

  it("loads this property's applicant", async () => {
    expect((await attempt(a.applicant.id)).error).not.toBe('One of the applicants named could not be found.')
  })
})

describe('SEC-10: updateUnit refuses a unit from another property', () => {
  function form(rent: string) {
    const data = new FormData()
    data.set('name', `Hijacked-${unique}`)
    data.set('status', 'VACANT')
    data.set('marketDollars', rent)
    return data
  }

  it("does not touch B's unit through A's permission", async () => {
    await expect(updateUnit(a.property.id, b.unit.id, {}, form('1'))).rejects.toThrow()
    const after = await prisma.unit.findUniqueOrThrow({ where: { id: b.unit.id } })
    expect(after.name).toBe(`U-${unique}`)
    expect(after.marketRentCents).toBe(150_000)
  })
})
