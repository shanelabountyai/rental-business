import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The compliance calendar (PROP-05, R-077): a PM adds a recurring
// obligation, sees it on the calendar, records that it was satisfied, and
// the due date advances to the next cycle - the "permanent completion log
// that answers 'when was this last done' in one lookup" the PRD asks for.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []

async function seedProperty() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Compliance LLC-${stamp}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Compliance House-${stamp}`,
      addressLine1: '1 Filing Ave',
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

async function seedManager(propertyId: string) {
  const email = `compliance-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Compliance Manager',
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
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

test('a PM adds a recurring item, records completion, and the due date advances', async ({ page }) => {
  const { property, stamp } = await seedProperty()
  const staff = await seedManager(property.id)
  await signIn(page, staff)

  await page.goto('/compliance/new')
  await page.getByLabel('Type').selectOption('SMOKE_CO_CERTIFICATION')
  await page.getByLabel('Property').selectOption({ label: property.name })
  await page.getByLabel('Label').fill(`Smoke cert ${stamp}`)
  await page.getByLabel('Due').fill('2026-09-01')
  await page.getByLabel('Recurs every (months, optional)').fill('12')
  await page.getByLabel('Alert lead time (days)').fill('14')
  await page.getByRole('button', { name: 'Add item' }).click()
  await page.waitForURL(/\/compliance\/(?!new$)[a-z0-9]+$/)

  await expect(page.getByRole('heading', { name: `Smoke cert ${stamp}` })).toBeVisible()
  // friendlyDate() uses en-GB with a short month - "Sept", not "Sep", is
  // that locale's own abbreviation for September specifically.
  await expect(page.getByText('due 1 Sept 2026')).toBeVisible()
  await expect(page.getByText('recurs every 12mo')).toBeVisible()
  await expect(page.getByText('Never recorded as done.')).toBeVisible()

  const a11y = await axeScan(page)
  expect(a11y.violations).toEqual([])

  await page.getByLabel('Completed on').fill('2026-08-20')
  await page.getByLabel('Notes (optional)').fill('Replaced batteries, tested all units')
  await page.getByRole('button', { name: 'Record completion' }).click()
  await expect(page.getByText('Replaced batteries, tested all units')).toBeVisible()

  // Recurs every 12 months from the completion date (2026-08-20), not the
  // original due date - nextComplianceDueDate()'s own contract.
  await expect(page.getByText('due 20 Aug 2027')).toBeVisible()

  const item = await prisma.complianceItem.findFirstOrThrow({ where: { label: `Smoke cert ${stamp}` } })
  expect(item.dueOn.toISOString().slice(0, 10)).toBe('2027-08-20')

  const completion = await prisma.complianceCompletion.findFirstOrThrow({
    where: { complianceItemId: item.id },
  })
  expect(completion.completedOn.toISOString().slice(0, 10)).toBe('2026-08-20')

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'compliance.completed', entityId: item.id },
  })
  expect(audited).not.toBeNull()

  await page.goto('/compliance')
  await expect(page.getByText(new RegExp(`Smoke cert ${stamp}`))).toBeVisible()
})
