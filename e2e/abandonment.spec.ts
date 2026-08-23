import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Tenant goes dark / abandonment (RISK-01, R-087).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES: THAT THE DISPOSAL GATE HOLDS.
//
// The clocks are pure and unit-tested in packages/core/abandonment, and the
// CHECK constraints are proved against a database in
// lib/abandonment/abandonment.test.ts. What neither can show is the join —
// that a PM looking at a case whose storage period has not run is not offered
// a disposal button at all, is told why, and is still refused if they post
// the form anyway.
//
// The second assertion is the one that keeps this workflow honest in the
// other direction: an UNCONFIGURED state period refuses too. That is the only
// place in this product where a missing jurisdiction rule blocks rather than
// warns, and if it ever silently starts permitting disposal instead, nothing
// else anywhere goes red.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const caseIds: string[] = []
const ruleIds: string[] = []

/// Its own state code per run, so this file's jurisdiction rows can never be
/// confused with another spec's — the lesson R-087 learned from two unit
/// tests quietly sharing 'ZZ'.
function stateCode(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return `Q${letters[Math.floor(Math.random() * 26)]}`
}

async function seedTenancy(options: {
  belongingsStorageDays?: number | null
  belongingsNoticeDays?: number | null
} = {}) {
  const stamp = randomUUID().slice(0, 8)
  const state = stateCode()
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 3,
      lateFeeType: 'NONE',
      entryNoticeHours: 24,
      abandonmentPresumedAfterDays: 14,
      belongingsStorageDays: options.belongingsStorageDays ?? null,
      belongingsNoticeDays: options.belongingsNoticeDays ?? null,
      paymentAllocationOrder: ['RENT'],
    },
  })
  ruleIds.push(rule.id)

  const entity = await prisma.legalEntity.create({
    data: { name: `Dark LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Dark House-${stamp}`,
      addressLine1: '2 Quiet Lane',
      city: 'Houston',
      state,
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Jo', lastName: `Gone-${stamp}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { property, unit, lease }
}

/// Portfolio-wide: `/abandonment` opens with an unscoped
/// `requirePermission('eviction.manage')`, the same trap fee-waiver,
/// lease-holds and scra specs each record for their own pages.
async function seedOwner() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `dark-${randomUUID()}@example.test`,
      name: 'Gone Dark Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function openHeldCase(args: {
  propertyId: string
  unitId: string
  leaseId: string
  staffId: string
  heldFrom: Date
}) {
  const created = await prisma.abandonmentCase.create({
    data: {
      propertyId: args.propertyId,
      unitId: args.unitId,
      leaseId: args.leaseId,
      openedByStaffId: args.staffId,
      status: 'BELONGINGS_HELD',
      enteredAt: new Date('2026-08-02T15:00:00.000Z'),
      entryFindings: 'Post piled at the door, fridge cleared, most furniture gone.',
      belongingsHeldFrom: args.heldFrom,
      belongingsInventory: 'Four boxes, a bicycle, a television.',
    },
  })
  caseIds.push(created.id)
  return created
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.abandonmentCase.deleteMany({ where: { id: { in: caseIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({
    where: { propertyId: { in: propertyIds } },
    data: { status: 'ENDED' },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.$disconnect()
})

test('THE GATE: disposal is refused while the storage period is still running', async ({
  page,
}) => {
  const { property, unit, lease } = await seedTenancy({ belongingsStorageDays: 30 })
  const staff = await seedOwner()
  // Secured yesterday, against a 30-day period.
  const heldFrom = new Date(Date.now() - 86_400_000)
  const created = await openHeldCase({
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    staffId: staff.id,
    heldFrom: new Date(heldFrom.toISOString().slice(0, 10) + 'T00:00:00.000Z'),
  })

  await signIn(page, staff.email)
  await page.goto(`/abandonment/${created.id}`)

  await expect(page.getByText(/storage period has not run/i)).toBeVisible()
  await expect(page.getByText(/earliest lawful date is/i)).toBeVisible()
  // Not offered at all — the reason is on screen instead of a button.
  await expect(page.getByRole('button', { name: 'Record the disposal' })).toHaveCount(0)
})

test('THE OTHER GATE: an UNCONFIGURED state period refuses too', async ({ page }) => {
  // The only place in this product where a missing jurisdiction rule blocks
  // rather than warns. Everywhere else an unknown period is reported and the
  // decision left with the human; disposal is the one step that cannot be
  // undone.
  const { property, unit, lease } = await seedTenancy({ belongingsStorageDays: null })
  const staff = await seedOwner()
  const created = await openHeldCase({
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    staffId: staff.id,
    heldFrom: new Date('2020-01-01T00:00:00.000Z'),
  })

  await signIn(page, staff.email)
  await page.goto(`/abandonment/${created.id}`)

  // Held since 2020 — every clock has run, and it is still refused.
  await expect(page.getByText(/is not configured in this system/i)).toBeVisible()
  await expect(page.getByText(/is conversion/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record the disposal' })).toHaveCount(0)
})

test('disposal is allowed once the period has run, and records what was done', async ({
  page,
}) => {
  const { property, unit, lease } = await seedTenancy({ belongingsStorageDays: 30 })
  const staff = await seedOwner()
  const created = await openHeldCase({
    propertyId: property.id,
    unitId: unit.id,
    leaseId: lease.id,
    staffId: staff.id,
    heldFrom: new Date('2026-01-01T00:00:00.000Z'),
  })

  await signIn(page, staff.email)
  await page.goto(`/abandonment/${created.id}`)

  await page.getByLabel('What was done with it').fill('Sold at auction; proceeds to the ledger.')
  await page.getByRole('button', { name: 'Record the disposal' }).click()

  await expect
    .poll(() =>
      prisma.abandonmentCase
        .findUniqueOrThrow({ where: { id: created.id } })
        .then((row) => row.belongingsDisposedAt !== null),
    )
    .toBe(true)
})

test('a logged contact that REACHED somebody says so plainly', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const created = await prisma.abandonmentCase.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      leaseId: lease.id,
      openedByStaffId: staff.id,
      lastContactOn: new Date('2026-07-01T00:00:00.000Z'),
    },
  })
  caseIds.push(created.id)

  await signIn(page, staff.email)
  await page.goto(`/abandonment/${created.id}`)

  // The evidence section leads with what is NOT yet true.
  await expect(page.getByText(/house rule, not a statute/i)).toBeVisible()

  await page.getByLabel('How did you try').selectOption('DOOR_KNOCK')
  await page.getByLabel('Result of the attempt').selectOption('REACHED')
  await page.getByLabel('Date of the attempt').fill('2026-08-10')
  await page.getByRole('button', { name: 'Log this attempt' }).click()

  // The single most important branch in the whole module.
  await expect(page.getByText(/this tenancy is not abandoned/i).first()).toBeVisible()
})
