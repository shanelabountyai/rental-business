import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// Scheduled-job health (R-174). The panel that finally reads `JobRun`, and the
// re-run control on it.
//
// Portfolio-wide, like /jurisdiction: `job.manage` is checked with a
// RESOURCE-LESS requirePermission, which only ever clears for a portfolio-wide
// grant. So a property-scoped manager must be refused even where their role
// carries the key - and the manager role does not carry it at all, because a
// new permission key is owner-only until somebody adds it to a role.
//
// The re-run itself is proved in apps/web/lib/jobs/jobs.test.ts against a real
// database, not here: a re-run needs a job REGISTERED in the running server's
// own `SCHEDULED_JOBS`, and a spec cannot push one into a process it is
// talking to over HTTP. What this file owns is the screen - who reaches it,
// what it says, and that a failed run is visible on it at all.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []
const jobRunIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `jobs-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Jobs Test',
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
    data: { name: `Jobs LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Jobs House-${randomUUID().slice(0, 8)}`,
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
  // R-003 rate-limits staff sign-in per IP. Without a per-spec address every
  // file shares one bucket and the eleventh login of a full sweep is refused,
  // sixty seconds later, inside whichever spec happened to be running.
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.jobRun.deleteMany({ where: { id: { in: jobRunIds } } })
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  // Deactivated, never deleted. Signing in writes an AuditLog row, and that
  // table is append-only by trigger - the FK's cascade is an UPDATE the
  // trigger refuses, so a delete here fails and takes every test in the file
  // with it. Same reason the property is only deactivated: an inactive
  // property is also the marker notifications.test.ts reads as "this spec has
  // finished".
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
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

test.describe('scheduled job health', () => {
  test('an owner sees every registered job and its last success', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/jobs')
    await expect(
      page.getByRole('heading', { name: 'Scheduled jobs', exact: true }),
    ).toBeVisible()
    // Every registered job renders whether or not it has ever produced a run
    // row - the whole reason the panel reads the registry rather than the
    // table. The billing sweep is one of the four carrying a legal clock.
    await expect(page.getByText('billing.sweep')).toBeVisible()
  })

  test('a failed run is shown with its error and a re-run control', async ({
    page,
  }) => {
    const property = await seedProperty()
    const run = await prisma.jobRun.create({
      data: {
        jobType: 'billing.sweep',
        propertyId: property.id,
        businessDate: new Date('2026-08-04T00:00:00.000Z'),
        status: 'FAILED',
        error: `synthetic failure ${randomUUID().slice(0, 8)}`,
        finishedAt: new Date(),
      },
    })
    jobRunIds.push(run.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/jobs')

    await expect(page.getByText(run.error!)).toBeVisible()
    // The accessible name carries the job and the date, because the panel
    // renders one of these per failed run and a page of buttons all called
    // "Re-run" is ambiguous to anyone navigating by label.
    await expect(
      page.getByRole('button', { name: new RegExp(`Re-run.*${property.name}`) }),
    ).toBeVisible()
  })

  test('a property-scoped manager cannot reach it', async ({ page }) => {
    const property = await seedProperty()
    const staff = await createStaff('manager', { propertyId: property.id })
    await signIn(page, staff.email)

    await page.goto('/jobs')
    await page.waitForURL(/\/no-access/)
    // The nav must not offer a door that refuses them.
    await expect(
      page.getByRole('link', { name: 'Scheduled jobs' }),
    ).toHaveCount(0)
  })

  test('has no accessibility violations', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/jobs')
    await expect(
      page.getByRole('heading', { name: 'Scheduled jobs', exact: true }),
    ).toBeVisible()
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
