import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The five weekly operating reports (RPT-04, R-076).
//
// Rent roll + delinquency aging already has its own e2e coverage
// (rent-roll.spec.ts); vacancy/turn status's underlying drill-down already
// has its own (dashboard.spec.ts's "vacancies tile" test). This file
// proves what is new: the /reports index links to all five, and the two
// genuinely new pages (cash summary, critical dates) render real numbers
// from real fixtures.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []

function daysFromNow(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return new Date(d.toISOString().slice(0, 10) + 'T00:00:00.000Z')
}

async function seedProperty() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Reports LLC-${stamp}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Reports House-${stamp}`,
      addressLine1: '1 Weekly Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return { property, stamp }
}

async function seedActiveLeaseExpiringSoon(propertyId: string, stamp: string) {
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Cash', lastName: `Flow-${stamp}`, email: `cash-${stamp}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2025-01-01'),
      endsOn: daysFromNow(30),
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return { unit, lease }
}

async function seedManager(propertyId: string) {
  const email = `reports-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Reports Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id, propertyId } })
  return staff
}

async function signIn(page: import('@playwright/test').Page, staff: { email: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

test('the reports index links to all five, and cash summary + critical dates show real numbers', async ({
  page,
}) => {
  const { property, stamp } = await seedProperty()
  const { unit } = await seedActiveLeaseExpiringSoon(property.id, stamp)
  const staff = await seedManager(property.id)
  await signIn(page, staff)

  await page.goto('/reports')
  await expect(page.getByRole('link', { name: /Rent roll \+ delinquency aging/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Open work orders by age/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Vacancy & turn status/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Cash summary per entity/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Upcoming critical dates/ })).toBeVisible()

  const a11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(a11y.violations).toEqual([])

  await page.getByRole('link', { name: /Cash summary per entity/ }).click()
  await expect(page).toHaveURL(/\/reports\/cash/)
  await expect(page.getByRole('heading', { name: new RegExp(`Reports LLC-${stamp}`) })).toBeVisible()
  await expect(page.getByText('$1,500.00')).toBeVisible() // billed = rentCents

  await page.goto('/reports/dates')
  await expect(page.getByText(new RegExp(`Lease ends — ${unit.name}`))).toBeVisible()

  const datesA11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(datesA11y.violations).toEqual([])
})
