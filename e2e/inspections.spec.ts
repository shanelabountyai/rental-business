import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The inspection engine, phase 1 (INSP-01, R-068).
//
// Pure status/validation logic is proved directly in
// packages/core/inspections/{status,validate}.test.ts, and the reads
// against a real database in apps/web/lib/inspections/*.test.ts. What only
// a browser proves is here: a PM building a checklist, starting an
// inspection from it, walking every item, finishing, signing and locking -
// and that a locked report genuinely refuses further edits.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const templateIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `inspection-${unique}@example.test`,
      name: `Inspection Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedUnit() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Inspection LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Inspection House-${unique}`,
      addressLine1: '15 Checklist Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  unitIds.push(unit.id)
  return { property, unit, unique }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.afterAll(async () => {
  await prisma.inspectionTemplate.updateMany({
    where: { id: { in: templateIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a PM builds a checklist, walks an inspection start to finish, and locks it', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property, unit, unique } = await seedUnit()
  await signIn(page, staff.email)

  // Build the checklist.
  await page.goto('/inspections/templates/new')
  await page.getByLabel('Name').fill(`Standard-${unique}`)
  // A fixed set of blank row slots (InspectionTemplateForm's own comment on
  // why), not a client-side "Add item" button.
  await page.getByLabel('Room').first().fill('Kitchen')
  await page.getByLabel('Item').first().fill('Refrigerator')
  await page.getByLabel('Room').nth(1).fill('Bathroom')
  await page.getByLabel('Item').nth(1).fill('Tub')
  await page.getByRole('button', { name: 'Save' }).click()
  // Excludes "new" itself, which also matches [a-z0-9]+ - the same
  // `(?!new$)` exclusion this repo's own e2e specs already use elsewhere.
  await expect(page).toHaveURL(/\/inspections\/templates\/(?!new$)[a-z0-9]+$/)

  const template = await prisma.inspectionTemplate.findFirstOrThrow({
    where: { name: `Standard-${unique}` },
  })
  templateIds.push(template.id)
  expect(template.items).toEqual([
    { room: 'Kitchen', item: 'Refrigerator' },
    { room: 'Bathroom', item: 'Tub' },
  ])

  // Start an inspection from it.
  await page.goto('/inspections/new')
  await page.getByLabel('Unit').selectOption({ label: `${property.name} — ${unit.name}` })
  await page.getByLabel('Type').selectOption('PERIODIC')
  await page.getByLabel('Checklist').selectOption({ label: `Standard-${unique}` })
  await page.getByRole('button', { name: 'Start inspection' }).click()
  await expect(page).toHaveURL(/\/inspections\/(?!new$)[a-z0-9]+$/)

  const inspection = await prisma.inspection.findFirstOrThrow({ where: { unitId: unit.id } })
  expect(inspection.templateId).toBe(template.id)

  await expect(page.getByText('Kitchen — Refrigerator')).toBeVisible()
  await expect(page.getByText('Bathroom — Tub')).toBeVisible()

  // "Finish walk" is refused server-side before every item is recorded.
  await page.getByRole('button', { name: 'Finish walk' }).click()
  await expect(page.getByText(/still need/)).toBeVisible()

  const items = await prisma.inspectionItem.findMany({ where: { inspectionId: inspection.id } })
  const kitchen = items.find((i) => i.room === 'Kitchen')!
  const bathroom = items.find((i) => i.room === 'Bathroom')!

  // Walk each item.
  const kitchenForm = page.locator('li', { hasText: 'Kitchen — Refrigerator' });
  await kitchenForm.getByLabel('Condition').selectOption('GOOD')
  await kitchenForm.getByLabel('Notes').fill('Clean, working.')
  await kitchenForm.getByRole('button', { name: 'Save' }).click()

  const bathroomForm = page.locator('li', { hasText: 'Bathroom — Tub' });
  await bathroomForm.getByLabel('Condition').selectOption('FAIR')
  await bathroomForm.getByLabel('Notes').fill('Minor staining.')
  await bathroomForm.getByRole('button', { name: 'Save' }).click()

  await expect
    .poll(async () => (await prisma.inspectionItem.findUniqueOrThrow({ where: { id: kitchen.id } })).condition)
    .toBe('GOOD')
  await expect
    .poll(async () => (await prisma.inspectionItem.findUniqueOrThrow({ where: { id: bathroom.id } })).condition)
    .toBe('FAIR')

  // Finish, sign, lock.
  await page.getByRole('button', { name: 'Finish walk' }).click()
  await expect(page.getByText('PERIODIC · Pending signature')).toBeVisible()

  await page.getByRole('button', { name: 'Record tenant signature' }).click()
  await expect(page.getByText('PERIODIC · Signed')).toBeVisible()

  await page.getByRole('button', { name: 'Lock report' }).click()
  await expect(page.getByText(/cannot be edited/)).toBeVisible()

  const locked = await prisma.inspection.findUniqueOrThrow({ where: { id: inspection.id } })
  expect(locked.lockedAt).not.toBeNull()
  expect(locked.tenantSignedAt).not.toBeNull()
  expect(locked.performedAt).not.toBeNull()

  // Locked means locked - no more per-item forms, read-only rows instead.
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await expect(page.getByText('Clean, working.')).toBeVisible()

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'inspection.locked', entityId: inspection.id },
  })
  expect(audited).not.toBeNull()
})
