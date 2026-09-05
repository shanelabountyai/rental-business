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

async function createStaff(roleKey: string | null, scopedToPropertyId?: string) {
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
      data: {
        staffUserId: staff.id,
        roleId: role.id,
        propertyId: scopedToPropertyId ?? null,
      },
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

  // R-123, AND THE ONLY REASON IT SURVIVED IS THAT NOTHING LOOKED. Every nav
  // test above signs in a PORTFOLIO-WIDE actor, so the whole scoped half of
  // the permission model was never rendered. A property-scoped manager got a
  // COMPLETELY EMPTY left nav - not a wrong link, none at all - while all of
  // their pages worked and scoped correctly, which is exactly why no page
  // test noticed either.
  //
  // The cause was `can(actor, permission)` with no resource: an omitted
  // propertyId compares `undefined === '<id>'`, so a resource-less check is
  // satisfied ONLY by a portfolio-wide assignment. `holdsAnywhere` is the
  // question the nav actually meant to ask.
  test('shows a property-scoped manager the sections they can use', async ({
    page,
  }) => {
    const { property } = await createProperty('Scoped Co', 'Scoped House')
    const staff = await createStaff('manager', property.id)
    await signIn(page, staff.email)

    const nav = page.getByRole('navigation', { name: 'Sections' })
    // A manager scoped to one house still runs that house's leases and money.
    await expect(nav.getByRole('link', { name: 'Leases', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Money', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Properties', exact: true })).toBeVisible()

    // ...and the destination is real, not a link into a refusal.
    await nav.getByRole('link', { name: 'Money', exact: true }).click()
    await expect(page).not.toHaveURL(/\/no-access/)

    // The portfolio-wide destinations stay hidden, because they guard
    // themselves with a resource-less requirePermission a scoped actor cannot
    // pass - a visible link there would only dead-end.
    await expect(nav.getByRole('link', { name: 'Vendors', exact: true })).toHaveCount(0)
    await expect(
      nav.getByRole('link', { name: 'Jurisdiction rules', exact: true }),
    ).toHaveCount(0)
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

test.describe('the phone viewport', () => {
  /**
   * A LONG PROPERTY NAME MUST NOT MAKE THE PAGE WIDER THAN THE PHONE (R-170a).
   *
   * =========================================================================
   * This is the regression guard for the defect that made CI red for four
   * consecutive runs, and it seeds a deliberately long name because the
   * defect is DATA-DEPENDENT and the ordinary fixtures are too short to show
   * it.
   *
   * A native `<select>`'s min-content width is the width of its widest
   * `<option>`, and `min-width: auto` on a flex or grid item refuses to
   * shrink below min-content - so one long property name made the switcher
   * 398px wide in the header of every admin page, and the page wider than the
   * 412px device. Chromium's mobile emulation answers that by EXPANDING THE
   * LAYOUT VIEWPORT (measured: `innerWidth` 485 and 576 against a
   * `clientWidth` of 412), at which point Playwright's click point - computed
   * from `getBoundingClientRect` - stops matching where the browser
   * dispatches the press. Every click below the fold lands high, on whatever
   * sits above the target, and reports "<something> intercepts pointer
   * events" until the 60s timeout. It reads as a race and is not one: the
   * geometry is stable, so every retry misses identically, which is why
   * D-171 chased it as a race for three items and why the retry budget was
   * never going to help.
   *
   * WHY AXE DOES NOT COVER THIS. `overflow-x-auto` wrappers clip, so a
   * scrolling table does not widen `documentElement` - this assertion is
   * specifically about content that escapes the viewport entirely, which is
   * WCAG 1.4.10 (Reflow) and which axe cannot see at a desktop width.
   * `ui-classes.ts` already records the same lesson about a green scan at one
   * width; this asserts it at the width that matters.
   *
   * Deliberately asserted on `documentElement`, not on any one control: the
   * next instance of this will be some other unconstrained element, and the
   * page being wider than the device is the property that actually matters.
   * =========================================================================
   */
  test('a long property name does not widen the page past the device', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile-chrome',
      'A desktop viewport is wider than anything here; the defect only exists on a phone.',
    )

    // Two properties, because the switcher hides itself for an actor with one.
    await createProperty('Shell Reflow Entity', 'Shell Reflow House')
    await createProperty(
      'Shell Reflow Entity With A Deliberately Very Long Legal Name LLC',
      'Shell Reflow House On A Deliberately Very Long Street Name',
    )
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    for (const url of ['/dashboard', '/properties', '/inspections']) {
      await page.goto(url)
      const width = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
      }))
      expect(
        width.scrollWidth,
        `${url} is ${width.scrollWidth}px wide on a ${width.clientWidth}px viewport`,
      ).toBeLessThanOrEqual(width.clientWidth)
      // The layout viewport itself expanding is the mechanism that breaks
      // every click below the fold, so assert it directly rather than
      // inferring it.
      expect(width.innerWidth, `${url} expanded the layout viewport`).toBe(
        width.clientWidth,
      )
    }
  })
})
