import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Vendor records themselves (MAINT-11, R-079) - no admin surface for
// "manage vendor records" existed before this item. `vendor.write` is
// portfolio-wide (no resource passed), the same posture `jurisdiction.write`
// already takes for an entity with no property column of its own - so this
// needs an owner, not a property-scoped manager.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const vendorIds: string[] = []

async function seedOwner() {
  const email = `vendormgmt-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Vendor Test Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
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
  await prisma.vendor.updateMany({ where: { id: { in: vendorIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a PM adds a vendor with no W-9, sees it flagged on the list, then fixes it', async ({ page }) => {
  const stamp = randomUUID().slice(0, 8)
  const staff = await seedOwner()
  await signIn(page, staff)

  await page.goto('/vendors/new')
  // Not getByLabel('Name') - it collides with "Contact name" by substring
  // match even with exact:true in this environment; the field's own stable
  // id is unambiguous.
  await page.locator('#field-name').fill(`Ace Plumbing ${stamp}`)
  await page.getByLabel('Trades (comma-separated)').fill('plumbing, hvac')
  // W-9 left unchecked deliberately - the "no W-9" flag case.
  await page.getByRole('button', { name: 'Add vendor' }).click()
  await page.waitForURL(/\/vendors\/(?!new$)[a-z0-9]+$/)

  const vendor = await prisma.vendor.findFirstOrThrow({ where: { name: `Ace Plumbing ${stamp}` } })
  vendorIds.push(vendor.id)
  expect(vendor.trades).toEqual(['plumbing', 'hvac'])
  expect(vendor.w9OnFile).toBe(false)

  await page.goto('/vendors')
  const row = page.getByRole('link', { name: new RegExp(`Ace Plumbing ${stamp}`) })
  await expect(row.getByText(/no W-9/)).toBeVisible()

  const a11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(a11y.violations).toEqual([])

  // Fix it.
  await row.click()
  await page.getByLabel('W-9 on file').check()
  // The edit form redirects to the SAME url it's already on, so
  // waitForURL would resolve trivially without waiting for the save to
  // land - watch the submit button's pending state instead (it flips to
  // "Working..." then back to "Save" once the server action + redirect
  // finish and the page remounts with fresh data).
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()

  await page.goto('/vendors')
  await expect(page.getByRole('link', { name: new RegExp(`Ace Plumbing ${stamp}`) }).getByText(/no W-9/)).toHaveCount(0)

  const updated = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })
  expect(updated.w9OnFile).toBe(true)

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'vendor.record_saved', entityId: vendor.id },
  })
  expect(audited).not.toBeNull()
})

test('an assignment picker shows a preferred vendor first and flags a lapsed COI', async ({ page }) => {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Vendor Pick LLC-${stamp}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Vendor Pick House-${stamp}`,
      addressLine1: '1 Pick Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  const unit = await prisma.unit.create({ data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' } })
  const preferred = await prisma.vendor.create({
    data: { name: `Preferred Plumber ${stamp}`, trades: ['plumbing'], preferredRank: 1, w9OnFile: true },
  })
  const lapsed = await prisma.vendor.create({
    data: {
      name: `Lapsed Plumber ${stamp}`,
      trades: ['plumbing'],
      w9OnFile: true,
      coiExpiresOn: new Date('2020-01-01'),
    },
  })
  vendorIds.push(preferred.id, lapsed.id)
  const workOrder = await prisma.workOrder.create({
    data: { propertyId: property.id, unitId: unit.id, scope: `Fix the sink ${stamp}`, status: 'SUBMITTED' },
  })

  const staff = await seedOwner()
  await signIn(page, staff)
  await page.goto(`/workorders/${workOrder.id}`)

  const select = page.getByLabel('Assign to vendor')
  const options = await select.locator('option').allTextContents()
  const preferredIndex = options.findIndex((o) => o.includes(`Preferred Plumber ${stamp}`))
  const lapsedIndex = options.findIndex((o) => o.includes(`Lapsed Plumber ${stamp}`))
  expect(preferredIndex).toBeGreaterThan(-1)
  expect(lapsedIndex).toBeGreaterThan(-1)
  expect(preferredIndex).toBeLessThan(lapsedIndex)
  expect(options[lapsedIndex]).toContain('COI expired')

  await prisma.workOrder.deleteMany({ where: { id: workOrder.id } })
  await prisma.unit.deleteMany({ where: { id: unit.id } })
  await prisma.property.updateMany({ where: { id: property.id }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entity.id }, data: { active: false } })
})
