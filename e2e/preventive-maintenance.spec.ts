import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'

// R-003's login limiter is ten attempts per IP per five minutes, and local
// e2e traffic carries no x-forwarded-for - so without this every spec shares
// one bucket and the full sweep starts refusing sign-ins around test 200.
// See uniqueClientHeaders' own comment: the symptom looks nothing like the
// cause.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

// Preventive-maintenance batch templates (MAINT-08, R-080): a PM creates a
// recurring task once, then "one click creates the batch across
// properties, assigned by vendor territory."

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const vendorIds: string[] = []
const templateIds: string[] = []

async function seedOwner() {
  const email = `pm-e2e-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Preventive Test Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedPropertyAndUnit() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `PM LLC-${stamp}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `PM House-${stamp}`,
      addressLine1: '9 Filter Ln',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  return { property, unit }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.afterAll(async () => {
  await prisma.workOrder.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.preventiveMaintenanceTemplate.updateMany({ where: { id: { in: templateIds } }, data: { active: false } })
  await prisma.vendor.updateMany({ where: { id: { in: vendorIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a PM creates a template and runs the batch, auto-assigning by territory', async ({ page }) => {
  const { property, unit } = await seedPropertyAndUnit()
  // A trade unique to this test run, not a realistic string like "hvac" -
  // the vendor pool is portfolio-wide and shared with whatever else the
  // full suite has active concurrently (D-68's own posture), so a common
  // trade name risks a same-territory vendor from another spec winning the
  // ranking instead of this test's own.
  const trade = `hvac-${randomUUID().slice(0, 8)}`
  const vendor = await prisma.vendor.create({
    data: { name: `Territory HVAC-${randomUUID().slice(0, 6)}`, trades: [trade], serviceAreas: ['Houston'], active: true },
  })
  vendorIds.push(vendor.id)

  const staff = await seedOwner()
  await signIn(page, staff.email)

  const templateName = `HVAC filter change ${randomUUID().slice(0, 6)}`
  await page.goto('/maintenance/preventive/new')
  await page.locator('#field-name').fill(templateName)
  await page.getByLabel('Trade (optional)').fill(trade)
  await page.getByLabel('Repeats every (months)').fill('6')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.waitForURL(/\/maintenance\/preventive$/)

  const template = await prisma.preventiveMaintenanceTemplate.findFirstOrThrow({
    where: { name: templateName },
  })
  templateIds.push(template.id)

  // Scoped to this template's own row, not a bare page-wide locator - `owner`
  // scope is portfolio-wide (R-079/D-68's own posture, reused here), so the
  // list can carry other tests' templates too when the full suite runs in
  // parallel, each with its own "Run batch" button.
  const row = page.locator('li', { hasText: templateName })
  // Not an exact "(1 due)" either, for the same reason: a brand-new
  // template with zero history is "due" for every unit currently in the
  // owner's scope, not only this test's own unit. What this test actually
  // owns is proven by querying for ITS OWN unit below, not the batch total.
  await row.getByRole('button', { name: /Run batch/ }).click()
  await expect(row.getByText(/Created \d+ work orders?/)).toBeVisible()

  const workOrder = await prisma.workOrder.findFirstOrThrow({
    where: { pmTemplateId: template.id, unitId: unit.id },
  })
  expect(workOrder.propertyId).toBe(property.id)
  expect(workOrder.vendorId).toBe(vendor.id)
  expect(workOrder.status).toBe('SUBMITTED')
})

test('a batch run leaves a unit unassigned when no vendor works its trade', async ({ page }) => {
  const { unit } = await seedPropertyAndUnit()
  // A trade unique to this test run and never assigned to any vendor -
  // guarantees zero matches regardless of what else the vendor pool holds
  // from other specs running concurrently (the same reasoning as the trade
  // above, applied the other direction: nobody has this trade, on purpose).
  const trade = `chimney-${randomUUID().slice(0, 8)}`

  const staff = await seedOwner()
  await signIn(page, staff.email)

  const templateName = `Chimney sweep ${randomUUID().slice(0, 6)}`
  await page.goto('/maintenance/preventive/new')
  await page.locator('#field-name').fill(templateName)
  await page.getByLabel('Trade (optional)').fill(trade)
  await page.getByLabel('Repeats every (months)').fill('12')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.waitForURL(/\/maintenance\/preventive$/)

  const template = await prisma.preventiveMaintenanceTemplate.findFirstOrThrow({
    where: { name: templateName },
  })
  templateIds.push(template.id)

  const row = page.locator('li', { hasText: templateName })
  await row.getByRole('button', { name: /Run batch/ }).click()
  await expect(row.getByText(/Created \d+ work orders?/)).toBeVisible()

  const workOrder = await prisma.workOrder.findFirstOrThrow({
    where: { pmTemplateId: template.id, unitId: unit.id },
  })
  expect(workOrder.vendorId).toBeNull()
})
