import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { daysSinceContact, getAbandonmentCase, listAbandonmentCases } from './queries.ts'

// Abandonment case files against a real database (RISK-01, R-087).
//
// ==========================================================================
// THE CONSTRAINTS, AND THE SCOPE.
//
// The two clocks are pure and unit-tested in packages/core/abandonment. What
// only a database can prove is that the four CHECK constraints refuse the
// records RISK-01 exists to prevent — a case closed with no account of how,
// an entry with no findings, a hold with no clock, and a disposal with no
// hold behind it — and that a case outside the reader's scope comes back as
// nothing rather than as somebody else's tenancy.
// ==========================================================================

let entityId: string
let propertyId: string
let unitId: string
let leaseId: string
let staffId: string
const caseIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `aband-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '2 Quiet Lane',
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
    data: { firstName: 'Jo', lastName: `Gone-${randomUUID().slice(0, 6)}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  leaseId = lease.id
  await prisma.leaseTenant.create({ data: { leaseId, tenantId: tenant.id, isPrimary: true } })
  const staff = await prisma.staffUser.create({
    data: { email: `aband-${randomUUID()}@example.test`, name: 'Case Opener' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // Attempts CASCADE from their case, and the case itself Restricts against
  // staff and lease — so the cases go and the roots are retired.
  await prisma.abandonmentCase.deleteMany({ where: { id: { in: caseIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: leaseId }, data: { status: 'ENDED' } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function openCase(overrides: Record<string, unknown> = {}) {
  const created = await prisma.abandonmentCase.create({
    data: { propertyId, unitId, leaseId, openedByStaffId: staffId, ...overrides },
  })
  caseIds.push(created.id)
  return created
}

describe('the database refuses an indefensible case', () => {
  it('will not close a case without saying how it ended', async () => {
    await expect(
      openCase({ status: 'CLOSED', closedAt: new Date() }),
    ).rejects.toThrow()
  })

  it('will not record an entry with no findings', async () => {
    // An entry nobody wrote down is the one that gets characterised later by
    // the other side.
    await expect(openCase({ status: 'ENTERED', enteredAt: new Date() })).rejects.toThrow()
  })

  it('accepts an entry with NO notice — emergency and permission are lawful without one', async () => {
    // `entryNoticeId` is deliberately not required: every jurisdiction that
    // requires notice carves out emergencies, and a schema that demanded a
    // notice row would make the lawful path unrecordable.
    const created = await openCase({
      status: 'ENTERED',
      enteredAt: new Date(),
      entryFindings: 'Post piled at the door, fridge cleared, no furniture in the back room.',
    })
    expect(created.entryNoticeId).toBeNull()
  })

  it('will not hold belongings without a date the clock runs from', async () => {
    await expect(
      openCase({
        status: 'BELONGINGS_HELD',
        enteredAt: new Date(),
        entryFindings: 'Empty but for boxes in the hall.',
        belongingsInventory: 'Four boxes, a bicycle, a television.',
      }),
    ).rejects.toThrow()
  })

  it('will not hold belongings without an inventory', async () => {
    await expect(
      openCase({
        status: 'BELONGINGS_HELD',
        enteredAt: new Date(),
        entryFindings: 'Empty but for boxes in the hall.',
        belongingsHeldFrom: new Date('2026-08-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow()
  })

  it('will not record a disposal with no hold behind it', async () => {
    await expect(openCase({ belongingsDisposedAt: new Date() })).rejects.toThrow()
  })

  it('accepts a properly held case', async () => {
    const created = await openCase({
      status: 'BELONGINGS_HELD',
      enteredAt: new Date(),
      entryFindings: 'Empty but for boxes in the hall.',
      belongingsHeldFrom: new Date('2026-08-01T00:00:00.000Z'),
      belongingsInventory: 'Four boxes, a bicycle, a television.',
    })
    expect(created.status).toBe('BELONGINGS_HELD')
  })
})

describe('reading a case', () => {
  it('reads the date-only columns without a timezone touching them', async () => {
    // America/Chicago, and `@db.Date` comes back as UTC midnight — reading it
    // through the zone reports the day before, which would shorten every
    // storage period by a day.
    const created = await openCase({
      lastContactOn: new Date('2026-07-15T00:00:00.000Z'),
      status: 'BELONGINGS_HELD',
      enteredAt: new Date(),
      entryFindings: 'Nothing but post.',
      belongingsHeldFrom: new Date('2026-08-01T00:00:00.000Z'),
      belongingsInventory: 'Two boxes.',
    })
    const view = await getAbandonmentCase(created.id, { propertyIds: [propertyId] } as never)
    expect(view!.lastContactOn).toBe('2026-07-15')
    expect(view!.belongingsHeldFrom).toBe('2026-08-01')
  })

  it('answers NOTHING for a case outside the reader’s scope', async () => {
    // ROLE-01: a record you cannot see comes back as absent, so the page
    // answers 404 and "forbidden" cannot be used to confirm it exists.
    const created = await openCase()
    expect(
      await getAbandonmentCase(created.id, { propertyIds: ['some-other-property'] } as never),
    ).toBeNull()
    expect((await listAbandonmentCases({ propertyIds: [] } as never)).length).toBe(0)
  })

  it('lists open cases before closed ones', async () => {
    const closed = await openCase({
      status: 'CLOSED',
      outcome: 'TENANT_RETURNED',
      outcomeNote: 'Came back from hospital.',
      closedAt: new Date(),
    })
    const open = await openCase()
    const rows = await listAbandonmentCases({ propertyIds: [propertyId] } as never)
    const ids = rows.map((row) => row.id)
    expect(ids.indexOf(open.id)).toBeLessThan(ids.indexOf(closed.id))
  })
})

describe('daysSinceContact', () => {
  it('is null when nobody has established a date', () => {
    expect(daysSinceContact(null, '2026-08-20')).toBeNull()
  })

  it('counts calendar days', () => {
    expect(daysSinceContact('2026-08-01', '2026-08-20')).toBe(19)
  })
})
