import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Turnover / make-ready through the browser (LEASE-12, R-072).
//
// The idempotent project creation and the auto-drafted punch list are
// proved against directly-seeded rows in start.test.ts and
// punch-list.test.ts. What only a browser proves is here: a PM can add a
// checklist item, set a target date and mark the turn rent-ready from the
// unit page, and the unit actually flips MAKE_READY -> VACANT.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const projectIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `turnover-${unique}@example.test`,
      name: `Turnover Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedTurn() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Turn LLC-${unique}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Turn House-${unique}`,
      addressLine1: '5 Turnover Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'MAKE_READY' },
  })
  unitIds.push(unit.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ENDED',
      startsOn: new Date('2025-01-01'),
      endsOn: new Date('2026-06-30'),
      rentCents: 150_000,
      moveOutAt: new Date('2026-06-30T18:00:00Z'),
    },
  })
  leaseIds.push(lease.id)
  const project = await prisma.turnoverProject.create({
    data: { propertyId: property.id, unitId: unit.id, leaseId: lease.id },
  })
  projectIds.push(project.id)
  return { property, unit, lease, project }
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
  await prisma.workOrder.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.turnoverProject.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test.describe('turnover', () => {
  test('a PM adds a checklist item, sets a target date, and marks the turn rent-ready', async ({ page }) => {
    const { property, unit, project } = await seedTurn()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await page.getByRole('heading', { name: 'Turnover' }).scrollIntoViewIfNeeded()
    await expect(page.getByText('No punch-list items yet.')).toBeVisible()

    await page.getByLabel('Add checklist item').fill('Paint the living room')
    await page.getByLabel('Stage').selectOption('PAINT')
    await page.getByRole('button', { name: 'Add' }).click()

    await page.waitForURL(new RegExp(`/units/${unit.id}$`))
    await expect(page.getByRole('link', { name: 'Paint the living room' })).toBeVisible()

    const workOrder = await prisma.workOrder.findFirstOrThrow({ where: { turnoverProjectId: project.id } })
    expect(workOrder.turnoverStage).toBe('PAINT')

    await page.getByLabel('Target rent-ready date').fill('2026-07-15')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByLabel('Target rent-ready date')).toHaveValue('2026-07-15')

    await page.getByRole('button', { name: 'Mark rent-ready' }).click()
    // `\w+`, for the reason spelled out in access-codes-move-in.spec.ts.
    // The `\w{3,4}` this replaces was the same bug patched one line deep:
    // it happens to cover "Sept" and still encodes a month-length guess.
    await expect(page.getByText(/Rent-ready \d{1,2} \w+ \d{4}/)).toBeVisible()

    const updatedUnit = await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
    expect(updatedUnit.status).toBe('VACANT')

    const entry = await prisma.auditLog.findFirst({ where: { action: 'turnover.rent_ready', entityId: project.id } })
    expect(entry).not.toBeNull()
  })
})
