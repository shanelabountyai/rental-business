import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The year-end tax export (RPT-03, R-078).
//
// The mapping arithmetic is unit-tested in packages/core/tax; what this file
// proves is the things only a real request can: that the page reads the
// actor's own scope, that the CSV route hands back a file with the exception
// rows IN IT, and that a hand-typed entity id outside scope gets 404 rather
// than somebody else's numbers.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const workOrderIds: string[] = []

async function createStaff(roleKey: string, scope?: { legalEntityId?: string }) {
  const email = `tax-export-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Tax Export Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId: scope?.legalEntityId },
  })
  return { ...staff, email, password: PASSWORD }
}

async function seedEntity(label: string) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `${label} LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${label} House-${stamp}`,
      addressLine1: '1 Schedule Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return { entity, property, stamp }
}

/// A closed, paid repair - the ordinary cash-basis expense line.
async function seedPaidJob(propertyId: string, stamp: string, invoiceCents: number) {
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'VACANT' },
  })
  unitIds.push(unit.id)
  const job = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId: unit.id,
      scope: `Water heater swap ${stamp}`,
      status: 'CLOSED',
      invoiceCents,
      closedAt: new Date('2026-04-02T15:00:00Z'),
      invoicePaidAt: new Date('2026-04-09T15:00:00Z'),
    },
  })
  workOrderIds.push(job.id)
  return job
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // Improvements first: `recordedByStaffId` is onDelete Restrict.
  await prisma.capitalImprovement.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...auditedProperties] } },
    data: { active: false },
  })
  const stillReferenced = new Set(
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entityIds } },
        select: { legalEntityId: true },
      })
    ).map((row) => row.legalEntityId),
  )
  await prisma.legalEntity.deleteMany({
    where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } },
  })

  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...auditedStaff] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('the report', () => {
  test('shows repairs on line 14 and holds CapEx off it', async ({ page }) => {
    const { entity, property, stamp } = await seedEntity('Cedar')
    await seedPaidJob(property.id, stamp, 42_500)
    const staff = await createStaff('owner')
    await prisma.capitalImprovement.create({
      data: {
        propertyId: property.id,
        category: 'ROOF',
        description: 'Full tear-off',
        costCents: 1_450_000,
        inServiceOn: new Date('2026-05-02T00:00:00Z'),
        recordedByStaffId: staff.id,
      },
    })
    await signIn(page, staff.email)

    await page.goto(`/reports/tax?entity=${entity.id}&year=2026&basis=cash`)

    // Scoped to the SUMMARY region throughout. Two things make a bare text
    // match wrong here: with no income the net is -$425.00, so "$425.00"
    // matches twice; and the can't-fill list renders "Line 18 · Depreciation
    // …" for the opposite reason to a total.
    const summary = page.getByRole('region', { name: entity.name, exact: false })
    const repairs = summary.locator('dt', { hasText: 'Line 14 · Repairs' })
    await expect(repairs).toBeVisible()
    await expect(repairs.locator('+ dd')).toHaveText('$425.00')
    await expect(summary.getByText('Line 18')).toHaveCount(0)

    // The roof is on the CapEx schedule, never on a Schedule E expense line.
    await expect(
      page
        .getByRole('region', { name: 'Held off Schedule E, deliberately' })
        .locator('dt', { hasText: 'Capital improvements placed in service' })
        .locator('+ dd'),
    ).toHaveText('$14,500.00')
  })

  test('books the same job in a different year when the basis changes', async ({ page }) => {
    const { entity, property, stamp } = await seedEntity('Straddle')
    const job = await seedPaidJob(property.id, stamp, 30_000)
    // Closed in December, paid in January: accrual books 2026, cash books 2027.
    await prisma.workOrder.update({
      where: { id: job.id },
      data: {
        closedAt: new Date('2026-12-28T15:00:00Z'),
        invoicePaidAt: new Date('2027-01-06T15:00:00Z'),
      },
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/reports/tax?entity=${entity.id}&year=2026&basis=accrual`)
    await expect(page.getByText('Line 14 · Repairs')).toBeVisible()

    await page.goto(`/reports/tax?entity=${entity.id}&year=2026&basis=cash`)
    await expect(page.getByText('Nothing booked to a Schedule E line')).toBeVisible()
  })

  test('names an improvement with no in-service date rather than dropping it', async ({ page }) => {
    const { entity, property } = await seedEntity('Undated')
    const staff = await createStaff('owner')
    await prisma.capitalImprovement.create({
      data: {
        propertyId: property.id,
        category: 'HVAC',
        description: 'Condenser and coil',
        costCents: 620_000,
        inServiceOn: null,
        recordedByStaffId: staff.id,
      },
    })
    await signIn(page, staff.email)

    await page.goto(`/reports/tax?entity=${entity.id}&year=2026&basis=cash`)
    await expect(page.getByText('No in-service date')).toBeVisible()
    await expect(page.getByText('Condenser and coil')).toBeVisible()
  })
})

test.describe('the CSV', () => {
  test('downloads with the exception rows in the same file', async ({ page }) => {
    const { entity, property, stamp } = await seedEntity('Csv')
    await seedPaidJob(property.id, stamp, 42_500)
    const staff = await createStaff('owner')
    await prisma.capitalImprovement.create({
      data: {
        propertyId: property.id,
        category: 'ROOF',
        description: 'Undated roof',
        costCents: 1_450_000,
        inServiceOn: null,
        recordedByStaffId: staff.id,
      },
    })
    await signIn(page, staff.email)

    const response = await page.request.get(
      `/api/reports/tax-export?entity=${entity.id}&year=2026&basis=cash`,
    )
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/csv')
    expect(response.headers()['content-disposition']).toContain('tax-export-')

    const csv = await response.text()
    expect(csv).toContain('Schedule E line')
    expect(csv).toContain('EXPENSE')
    // The mapped rows and the unmapped one arrive together - a reader must
    // not be able to take the totals away without seeing what did not map.
    expect(csv).toContain('EXCEPTION')
    expect(csv).toContain('No in-service date')
    expect(csv).toContain('425.00')
  })

  test('answers 404 for an entity outside the actor’s scope, not 403', async ({ page }) => {
    const { entity: mine } = await seedEntity('Mine')
    const { entity: theirs } = await seedEntity('Theirs')
    // Entity-scoped to their OWN entity only.
    const staff = await createStaff('manager', { legalEntityId: mine.id })
    await signIn(page, staff.email)

    const response = await page.request.get(
      `/api/reports/tax-export?entity=${theirs.id}&year=2026&basis=cash`,
    )
    // 404, deliberately: "forbidden" would confirm the entity exists (ROLE-01).
    expect(response.status()).toBe(404)
  })
})

test.describe('accessibility', () => {
  test('the tax export page has no detectable violations', async ({ page }) => {
    const { entity, property, stamp } = await seedEntity('Axe')
    await seedPaidJob(property.id, stamp, 42_500)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/reports/tax?entity=${entity.id}&year=2026&basis=cash`)
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
