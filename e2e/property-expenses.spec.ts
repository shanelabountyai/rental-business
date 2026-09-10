import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// Property expenses (R-193): tax, insurance and management fees nobody
// invoiced.
//
// The export arithmetic is unit-tested in packages/core/tax. What only a real
// request proves is that a bill entered on the form reaches the operating
// report's "All expenses", clears that house's missing-tax flag, and that a
// monthly series can be stopped from the page.

const PASSWORD = 'correct-horse-battery-staple'
// The houses' own clock, not UTC: the form refuses a date that has not
// happened yet where the property is, and early on 1 January UTC it is still
// last year in Houston.
const TODAY = businessDate(new Date(), 'America/Chicago')
const YEAR = Number(TODAY.slice(0, 4))

const staffIds: string[] = []
const entityIds: string[] = []

async function createOwner() {
  const email = `property-expense-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Property Expense Test',
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
    data: { name: `Expense LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const houses = []
  for (const label of ['Birch', 'Cedar']) {
    houses.push(
      await prisma.property.create({
        data: {
          legalEntityId: entity.id,
          name: `${label} Ct-${stamp}`,
          addressLine1: '1 Expense Way',
          city: 'Houston',
          state: 'TX',
          postalCode: '77002',
          timezone: 'America/Chicago',
          propertyType: 'SINGLE_FAMILY',
          acquiredOn: new Date('2019-01-01T00:00:00Z'),
        },
      }),
    )
  }
  return { entity, houses }
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // By OWNERSHIP: every row this file writes hangs off one of its entities.
  // Expenses first - their property and document keys are Restrict.
  await prisma.propertyExpense.deleteMany({ where: { legalEntityId: { in: entityIds } } })
  await prisma.property.updateMany({
    where: { legalEntityId: { in: entityIds } },
    data: { active: false },
  })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

async function fillExpense(
  page: import('@playwright/test').Page,
  options: {
    entityName: string
    propertyName: string
    category: string
    description: string
    amountDollars: string
    paidOn: string
    monthly?: boolean
  },
) {
  const form = page.getByRole('region', { name: 'Record an expense' })
  await form.getByLabel('Legal entity').selectOption({ label: options.entityName })
  await form.getByLabel('Property').selectOption({ label: options.propertyName })
  await form.getByLabel('Category').selectOption({ label: options.category })
  await form.getByLabel('What it was').fill(options.description)
  await form.getByLabel('Amount paid').fill(options.amountDollars)
  await form.getByLabel('Paid on').fill(options.paidOn)
  if (options.monthly) await form.getByLabel('Repeats monthly').check()
  await form.getByRole('button', { name: 'Record expense' }).click()
}

test.describe('recording a property expense', () => {
  test('a tax bill reaches the operating report and clears that house’s flag', async ({ page }) => {
    const { entity, houses } = await seedEntityWithTwoHouses()
    const owner = await createOwner()
    await signIn(page, owner.email)

    await page.goto('/money/expenses')
    await fillExpense(page, {
      entityName: entity.name,
      propertyName: houses[0].name,
      category: 'Taxes',
      description: `${YEAR - 1} county tax`,
      amountDollars: '4800',
      paidOn: `${YEAR}-01-01`,
    })
    // The form lives on the page it redirects to, so poll the row, not the URL.
    await expect
      .poll(() => prisma.propertyExpense.count({ where: { legalEntityId: entity.id } }))
      .toBe(1)

    await page.goto(`/reports/operating?entity=${entity.id}&year=${YEAR}&basis=accrual`)
    const snapshot = page.getByRole('table', { name: /Per-property operating snapshot/ })
    const taxed = snapshot.getByRole('row').filter({ hasText: houses[0].name })
    const untaxed = snapshot.getByRole('row').filter({ hasText: houses[1].name })

    // Income, Maintenance, All expenses, Net.
    await expect(taxed.getByRole('cell').nth(2)).toHaveText('$4,800.00')
    await expect(taxed.getByRole('cell').nth(3)).toHaveText('-$4,800.00')
    await expect(taxed.getByText('No insurance booked', { exact: true })).toBeVisible()
    await expect(untaxed.getByText('No property tax or insurance booked', { exact: true })).toBeVisible()
  })

  test('a monthly fee books its months and can be stopped', async ({ page }) => {
    const { entity, houses } = await seedEntityWithTwoHouses()
    const owner = await createOwner()
    await signIn(page, owner.email)

    await page.goto('/money/expenses')
    const description = `Management fee ${randomUUID().slice(0, 8)}`
    await fillExpense(page, {
      entityName: entity.name,
      propertyName: houses[1].name,
      category: 'Management fees',
      description,
      amountDollars: '150',
      paidOn: `${YEAR}-01-01`,
      monthly: true,
    })
    await expect
      .poll(() => prisma.propertyExpense.count({ where: { legalEntityId: entity.id } }))
      .toBe(1)

    const csv = await (
      await page.request.get(`/api/reports/tax-export?entity=${entity.id}&year=${YEAR}&basis=cash`)
    ).text()
    const months = csv.split('\n').filter((line) => line.includes(`${description} (monthly)`))
    // One line for every month so far this year - January at the least.
    expect(months).toHaveLength(Number(TODAY.slice(5, 7)))
    expect(months[0]).toContain('Management Fees')

    await page.goto('/money/expenses')
    // Scoped to this row: an owner sees every entity's expenses, including
    // the other browser project's copy of this test.
    const row = page
      .getByRole('region', { name: 'Recent expenses' })
      .getByRole('listitem')
      .filter({ hasText: description })
    await row.getByRole('button', { name: `Stop repeating ${description}` }).click()
    await expect
      .poll(async () =>
        (await prisma.propertyExpense.findFirstOrThrow({ where: { legalEntityId: entity.id } }))
          .recurrenceEndsOn,
      )
      .not.toBeNull()
    await expect(row.getByText(/monthly from 1 Jan/)).toBeVisible()
  })

  test('the property expenses page has no detectable violations', async ({ page }) => {
    await seedEntityWithTwoHouses()
    const owner = await createOwner()
    await signIn(page, owner.email)
    await page.goto('/money/expenses')
    await expect(page.getByRole('heading', { name: 'Property expenses' })).toBeVisible()
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
