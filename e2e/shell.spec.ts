import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The admin shell (R-007). What matters here beyond "it renders":
//
//   The nav shows only sections the actor may reach - and the ones it hides
//   are also unreachable by typing the URL, because hiding a link is not
//   authorization (ROLE-01).
//
//   The property switcher is a FILTER, never a grant. A property-scoped
//   manager cannot see another entity's properties in it.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function createStaff(roleKey: string | null) {
  const email = `shell-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Shell Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)

  if (roleKey) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
    await prisma.staffAssignment.create({
      data: { staffUserId: staff.id, roleId: role.id },
    })
  }
  return { ...staff, password: PASSWORD }
}

async function createProperty(entityName: string, propertyName: string) {
  const entity = await prisma.legalEntity.create({
    data: { name: `${entityName}-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${propertyName}-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return { entity, property }
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  // Audited staff users cannot be deleted (R-005), so deactivate them.
  const audited = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !audited.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !audited.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...audited] } },
    data: { active: false },
  })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds } } })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('the shell', () => {
  test('lands a signed-in owner on the dashboard with the full nav', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    const nav = page.getByRole('navigation', { name: 'Sections' })
    // `exact: true`, for the reason the next test down already documents:
    // an accessible-name match is a case-insensitive SUBSTRING, so
    // "Maintenance" also matches "Preventive maintenance" (R-080's own nav
    // entry) and the strict-mode locator resolves to two links. Latent since
    // that entry was added; surfaced by R-087 running this spec again.
    for (const label of [
      'Dashboard',
      'Properties',
      'Leases',
      'Maintenance',
      'Money',
      'Tasks',
    ]) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible()
    }
  })

  test('marks the current section for screen readers, not just visually', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Properties' })
      .click()

    await page.waitForURL('**/properties')
    // Scoped to the nav, and exact: an unscoped substring match here also
    // catches any property row whose OWNING ENTITY happens to have
    // "Properties" in its name (a thoroughly ordinary name for a rental
    // LLC) - a real, if latent, fragility this test had from the start,
    // exposed once the database held a property list with real names again.
    // A colour change alone says nothing to anyone who cannot see it.
    await expect(
      page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: 'Properties', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('hides sections a maintenance tech may not reach', async ({ page }) => {
    const staff = await createStaff('maintenance_tech')
    await signIn(page, staff.email)

    const nav = page.getByRole('navigation', { name: 'Sections' })
    // Exact here too — same substring trap as above.
    await expect(nav.getByRole('link', { name: 'Maintenance', exact: true })).toBeVisible()
    // No financials, no leases - the tech role carries neither permission.
    await expect(nav.getByRole('link', { name: 'Money', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Leases', exact: true })).toHaveCount(0)
  })

  // ROLE-01: "not just hidden UI". The link being absent proves nothing; the
  // route refusing is what matters.
  test('refuses a hidden section even when the URL is typed directly', async ({
    page,
  }) => {
    const staff = await createStaff('maintenance_tech')
    await signIn(page, staff.email)

    await page.goto('/money')
    await expect(page).toHaveURL(/\/no-access/)
    await expect(
      page.getByRole('heading', { name: /don.t have access/i, level: 1 }),
    ).toBeVisible()
    // Says which permission, so the person can ask for the right thing.
    await expect(page.getByText('ledger.read')).toBeVisible()
  })

  test('explains itself to a signed-in user with no roles', async ({ page }) => {
    const staff = await createStaff(null)
    await page.goto('/login')
    await page.getByLabel('Email').fill(staff.email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Deny by default: an actor with no assignment holds no permission, so
    // even the dashboard refuses - but with an explanation, not a crash page.
    await page.waitForURL(/\/no-access/)
    await expect(
      page.getByRole('heading', { name: /don.t have access/i, level: 1 }),
    ).toBeVisible()
  })

  test('has a skip link before the navigation', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    // A fresh navigation, so focus starts at the top of the document rather
    // than wherever the sign-in button left it.
    await page.goto('/dashboard')

    // Without it a keyboard user tabs through every nav link on every page.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  })

  test('has no accessibility violations', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })

  test('the no-access page has no accessibility violations', async ({ page }) => {
    const staff = await createStaff('maintenance_tech')
    await signIn(page, staff.email)
    await page.goto('/money')
    await expect(page).toHaveURL(/\/no-access/)

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})

test.describe('the property switcher', () => {
  test('is hidden when there is nothing to switch between', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    // Whether it shows depends on how many properties exist in this database,
    // so assert the invariant rather than a count: a control with one option
    // is noise.
    const options = page.locator('#property-scope option')
    const count = await page.locator('#property-scope').count()
    if (count === 0) {
      expect(count).toBe(0)
    } else {
      expect(await options.count()).toBeGreaterThan(1)
    }
  })

  test('offers all properties plus an entity filter to an owner', async ({
    page,
  }) => {
    const { entity, property } = await createProperty('Switcher Ltd', 'Elm St')
    await createProperty('Switcher Two', 'Oak St')
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    const select = page.locator('#property-scope')
    await expect(select).toBeVisible()
    await expect(
      select.getByRole('option', { name: 'All properties' }),
    ).toHaveCount(1)
    await expect(select.getByRole('option', { name: entity.name })).toHaveCount(1)
    await expect(
      select.getByRole('option', { name: property.name }),
    ).toHaveCount(1)
  })

  // The switcher narrows; it can never widen. A manager scoped to one property
  // must not find another entity's properties listed in it.
  test('never lists a property outside the actor’s scope', async ({ page }) => {
    const mine = await createProperty('Mine LLC', 'My House')
    const theirs = await createProperty('Theirs LLC', 'Their House')

    const staff = await createStaff(null)
    const role = await prisma.role.findUniqueOrThrow({
      where: { key: 'manager' },
    })
    await prisma.staffAssignment.create({
      data: {
        staffUserId: staff.id,
        roleId: role.id,
        propertyId: mine.property.id,
      },
    })

    await signIn(page, staff.email)
    const body = await page.locator('body').innerText()
    expect(body).not.toContain(theirs.property.name)
    expect(body).not.toContain(theirs.entity.name)
  })
})

test.describe('universal search', () => {
  test('routes the header search to a scoped stub', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.getByLabel('Search').fill('elm street')
    await page.getByLabel('Search').press('Enter')

    await page.waitForURL(/\/search\?q=/)
    await expect(
      page.getByRole('heading', { name: 'Search', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText(/elm street/)).toBeVisible()
    // The stub states the boundary its eventual index must honour.
    await expect(page.getByText(/never cross that boundary/)).toBeVisible()
  })
})
