import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// Split vendor invoices (PAY-10) and the reserve/capital-plan report (PAY-11),
// R-082.
//
// The arithmetic is unit-tested in packages/core; what only a real request can
// prove is that recording ONE bill across TWO houses lands both shares, that
// the sum rule is enforced at the form rather than only in a pure function,
// and that a work order claimed by a split stops being deducted on its own.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const workOrderIds: string[] = []
const vendorIds: string[] = []

async function createStaff() {
  const email = `invoice-split-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Invoice Split Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, email }
}

async function seedEntityWithTwoHouses() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Split LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)

  const houses = []
  for (const label of ['Oak', 'Elm']) {
    const property = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `${label} St-${stamp}`,
        addressLine1: '1 Split Way',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
        // Dates the capital plan's fallback, so the reserve report has
        // something to project rather than a page of "unknown".
        yearBuilt: 1996,
      },
    })
    propertyIds.push(property.id)
    const unit = await prisma.unit.create({
      data: { propertyId: property.id, name: `U-${label}-${stamp}`, status: 'VACANT' },
    })
    unitIds.push(unit.id)
    houses.push({ property, unit })
  }

  const vendor = await prisma.vendor.create({
    data: { name: `Ace Handyman-${stamp}`, trades: ['handyman'] },
  })
  vendorIds.push(vendor.id)

  return { entity, houses, vendor, stamp }
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // Invoices before work orders: a split's `workOrderId` is onDelete Restrict
  // on purpose, so the bill has to go first.
  await prisma.vendorInvoice.deleteMany({ where: { legalEntityId: { in: entityIds } } })
  await prisma.propertyReserve.deleteMany({ where: { propertyId: { in: propertyIds } } })
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
  await prisma.vendor.updateMany({ where: { id: { in: vendorIds } }, data: { active: false } })

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

/// Fills the header and the first two split lines. The form starts with three
/// lines; the third is left blank on purpose, because a blank row must be
/// dropped rather than reported as three errors.
async function fillInvoice(
  page: import('@playwright/test').Page,
  options: {
    entityName: string
    vendorName: string
    totalDollars: string
    lines: Array<{ propertyName: string; category: string; amountDollars: string }>
  },
) {
  await page.getByLabel('Legal entity').selectOption({ label: options.entityName })
  await page.getByLabel('Vendor').selectOption({ label: options.vendorName })
  await page.getByLabel('Invoice number').fill('4471')
  await page.getByLabel('Invoice total').fill(options.totalDollars)
  await page.getByLabel('Invoice date').fill('2026-03-14')
  await page.getByLabel('Paid on').fill('2026-03-20')

  for (const [index, line] of options.lines.entries()) {
    const group = page.getByRole('group', { name: 'How it splits' })
    await group.getByLabel('Property').nth(index).selectOption({ label: line.propertyName })
    await group.getByLabel('Category').nth(index).selectOption({ label: line.category })
    await group.getByLabel('Amount').nth(index).fill(line.amountDollars)
  }
}

test.describe('recording a split vendor invoice', () => {
  test('one bill lands on two houses, and the CSV carries both', async ({ page }) => {
    const { entity, houses, vendor } = await seedEntityWithTwoHouses()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/money/vendor-invoices')
    await fillInvoice(page, {
      entityName: entity.name,
      vendorName: vendor.name,
      totalDollars: '900',
      lines: [
        { propertyName: houses[0].property.name, category: 'Repairs', amountDollars: '400' },
        {
          propertyName: houses[1].property.name,
          category: 'Cleaning and maintenance',
          amountDollars: '500',
        },
      ],
    })
    await page.getByRole('button', { name: 'Record invoice' }).click()
    await page.waitForURL('**/money/vendor-invoices')

    // Scoped to THIS invoice's own list item. The page is scoped by split
    // property, so an owner sees every bill in scope - including the $900 ones
    // the other cases in this file record concurrently. The vendor name is
    // stamped unique per test; the amount is not.
    const recorded = page
      .getByRole('region', { name: 'Recent invoices' })
      .getByRole('listitem')
      .filter({ hasText: vendor.name })
      .first()
    await expect(recorded.getByText('$900.00')).toBeVisible()
    await expect(recorded.getByText('$400.00')).toBeVisible()
    await expect(recorded.getByText('$500.00')).toBeVisible()

    // Each share reaches the export on ITS OWN property and Schedule E line -
    // the whole point of PAY-10, and not something the list above proves.
    const response = await page.request.get(
      `/api/reports/tax-export?entity=${entity.id}&year=2026&basis=cash`,
    )
    expect(response.status()).toBe(200)
    const csv = await response.text()
    const oak = csv.split('\n').find((line) => line.includes(houses[0].property.name))
    const elm = csv.split('\n').find((line) => line.includes(houses[1].property.name))
    expect(oak).toContain('Repairs')
    expect(oak).toContain('400.00')
    expect(elm).toContain('Cleaning and Maintenance')
    expect(elm).toContain('500.00')
  })

  test('refuses lines that do not add up to the vendor total', async ({ page }) => {
    const { entity, houses, vendor } = await seedEntityWithTwoHouses()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/money/vendor-invoices')
    await fillInvoice(page, {
      entityName: entity.name,
      vendorName: vendor.name,
      totalDollars: '900',
      lines: [
        { propertyName: houses[0].property.name, category: 'Repairs', amountDollars: '400' },
        { propertyName: houses[1].property.name, category: 'Repairs', amountDollars: '300' },
      ],
    })
    await page.getByRole('button', { name: 'Record invoice' }).click()

    await expect(page.getByText('under by $200.00')).toBeVisible()
    // Nothing was written: a half-entered invoice is worse than none.
    expect(await prisma.vendorInvoice.count({ where: { legalEntityId: entity.id } })).toBe(0)
  })

  test('a job claimed by a split stops being deducted on its own', async ({ page }) => {
    const { entity, houses, vendor } = await seedEntityWithTwoHouses()
    const staff = await createStaff()

    // A closed, paid job carrying its own $260 invoice. The split below claims
    // it for $400 - the real share of the bill - and the $260 must vanish.
    const job = await prisma.workOrder.create({
      data: {
        propertyId: houses[0].property.id,
        unitId: houses[0].unit.id,
        vendorId: vendor.id,
        scope: 'Gutter run',
        status: 'CLOSED',
        invoiceCents: 26_000,
        closedAt: new Date('2026-03-10T15:00:00Z'),
        invoicePaidAt: new Date('2026-03-20T15:00:00Z'),
      },
    })
    workOrderIds.push(job.id)

    await signIn(page, staff.email)
    await page.goto('/money/vendor-invoices')
    await fillInvoice(page, {
      entityName: entity.name,
      vendorName: vendor.name,
      totalDollars: '900',
      lines: [
        { propertyName: houses[0].property.name, category: 'Repairs', amountDollars: '400' },
        { propertyName: houses[1].property.name, category: 'Repairs', amountDollars: '500' },
      ],
    })
    await page
      .getByRole('group', { name: 'How it splits' })
      .getByLabel('Work order ID')
      .first()
      .fill(job.id)
    await page.getByRole('button', { name: 'Record invoice' }).click()

    // POLL THE FACT, not the URL. `waitForURL('**/money/vendor-invoices')`
    // was here and was ALREADY TRUE before the click - the form lives on
    // that page, so the wait resolved instantly and the CSV fetch below
    // raced the write that was supposed to feed it. It won for months and
    // lost once at test 955 of a full sweep, which is exactly the shape
    // CLAUDE.md records for `getByText('active')`: an assertion that is
    // already true tests nothing and hides a race until load tips it over.
    //
    // The split claiming this job is the thing the export reads, so it is
    // the thing to wait for - the same call leases.spec.ts's own `leaseRow`
    // helper makes.
    await expect
      .poll(() => prisma.vendorInvoiceSplit.count({ where: { workOrderId: job.id } }))
      .toBe(1)

    const csv = await (
      await page.request.get(`/api/reports/tax-export?entity=${entity.id}&year=2026&basis=cash`)
    ).text()
    expect(csv).not.toContain(job.id)
    expect(csv).not.toContain('260.00')
    expect(csv).toContain('400.00')
  })
})

test.describe('the reserve and capital plan report', () => {
  test('records a target and a dated balance, and shows the gap', async ({ page }) => {
    const { houses } = await seedEntityWithTwoHouses()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/reports/reserves')
    const section = page.getByRole('region', { name: houses[0].property.name })
    await expect(section.getByText('Not set')).toBeVisible()

    await section.getByLabel('Target').fill('12000')
    await section.getByLabel('Balance held').fill('8450')
    await section.getByLabel('Counted on').fill('2026-08-01')
    await section.getByRole('button', { name: 'Save reserve' }).click()

    await expect(section.getByText('$3,550.00 short')).toBeVisible()
  })

  test('refuses a balance with no date, because it would always read as current', async ({
    page,
  }) => {
    const { houses } = await seedEntityWithTwoHouses()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/reports/reserves')
    const section = page.getByRole('region', { name: houses[0].property.name })
    await section.getByLabel('Target').fill('12000')
    await section.getByLabel('Balance held').fill('8450')
    await section.getByRole('button', { name: 'Save reserve' }).click()

    await expect(section.getByText('always reads as current')).toBeVisible()
    expect(
      await prisma.propertyReserve.count({ where: { propertyId: houses[0].property.id } }),
    ).toBe(0)
  })

  test('projects a component from year built, and says the age is assumed', async ({ page }) => {
    const { houses } = await seedEntityWithTwoHouses()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/reports/reserves')
    const section = page.getByRole('region', { name: houses[0].property.name })
    await section.getByText('The plan behind that number').click()

    // 1996 + 25 = 2021, so the roof reads as overdue rather than as a date in
    // the future - and the source is stated, never presented as a fact.
    await expect(section.getByText('2021 · overdue')).toBeVisible()
    await expect(section.getByText('assumed original — from year built').first()).toBeVisible()
  })

  test('has no accessibility violations', async ({ page }) => {
    const { houses } = await seedEntityWithTwoHouses()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto('/reports/reserves')
    await expect(page.getByRole('heading', { name: 'Reserves & capital plan' })).toBeVisible()
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
