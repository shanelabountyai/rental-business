import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// The screening-criteria admin screen (R-242; OQ-6). Portfolio-wide, like
// /jurisdiction and /jobs: `screening.criteria.read`/`.write` are checked
// with a RESOURCE-LESS requirePermission, which only ever clears for a
// portfolio-wide grant.
//
// DELIBERATELY READ-ONLY: unlike JurisdictionRule, ScreeningCriteria carries
// no scoping key at all (state, jurisdiction, property - nothing) - its own
// schema comment says the same criteria apply "across the whole portfolio,
// not a jurisdiction-by-jurisdiction patchwork". Superseding the real seeded
// v1 through the actual form, the way jurisdiction.spec.ts supersedes its own
// throwaway WY rule, would PERMANENTLY change which criteria govern every
// applicant in the shared `rental_test` database - including every other
// spec and unit test that reads `currentScreeningCriteria()` concurrently or
// in a later run, with no scoped row to clean up afterward and restore. This
// file only reads the real seeded criteria; it never versions them.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `screening-criteria-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Screening Criteria Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      propertyId: scope?.propertyId,
      legalEntityId: scope?.legalEntityId,
    },
  })
  return { ...staff, email }
}

async function seedProperty() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Screening Criteria LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Screening Criteria House-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffCredential.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.legalEntity.updateMany({
    where: { id: { in: entityIds } },
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

test.describe('screening criteria', () => {
  test('an owner sees the current, unreviewed criteria and the release-gate warning', async ({
    page,
  }) => {
    const current = await prisma.screeningCriteria.findFirstOrThrow({
      where: { effectiveTo: null },
      orderBy: { version: 'desc' },
    })

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/screening-criteria')

    await expect(
      page.getByRole('heading', { name: 'Screening criteria', exact: true }),
    ).toBeVisible()
    await expect(page.getByText(`v${current.version}`).first()).toBeVisible()

    // The seeded placeholder (OQ-6) has never been reviewed - if a later
    // session adds a reviewed version this assertion is meant to start
    // failing, which is the signal to update it, not to delete it.
    if (!current.reviewedBy) {
      await expect(page.getByText(/never been reviewed by an attorney/)).toBeVisible()
      await expect(page.getByText('unreviewed')).toBeVisible()
    }
  })

  test('a portfolio-wide manager can read but not version the criteria', async ({ page }) => {
    const staff = await createStaff('manager')
    await signIn(page, staff.email)

    await page.goto('/screening-criteria')
    await expect(
      page.getByRole('heading', { name: 'Screening criteria', exact: true }),
    ).toBeVisible()
    // manager carries screening.criteria.read, not .write (D-4's own split,
    // applied here: reviewing criteria is a legal release gate, not
    // day-to-day portfolio work) - no "New version" link, and the form
    // itself refuses.
    await expect(page.getByRole('link', { name: 'New version' })).toHaveCount(0)
    await page.goto('/screening-criteria/new')
    await page.waitForURL(/\/no-access/)
  })

  test('a property-scoped manager cannot reach it', async ({ page }) => {
    const property = await seedProperty()
    const staff = await createStaff('manager', { propertyId: property.id })
    await signIn(page, staff.email)

    await page.goto('/screening-criteria')
    await page.waitForURL(/\/no-access/)
    await expect(
      page.getByRole('link', { name: 'Screening criteria' }),
    ).toHaveCount(0)
  })

  test('has no accessibility violations', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/screening-criteria')
    await expect(
      page.getByRole('heading', { name: 'Screening criteria', exact: true }),
    ).toBeVisible()
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
