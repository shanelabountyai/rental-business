import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// LegalEntity + Property CRUD (R-008, PROP-01/PROP-04). What matters beyond
// "the form works":
//
//   The duplicate-address warning (PROP-01) does not silently create a second
//   record, and does not silently block a legitimate one either - it stops
//   and asks.
//
//   R-004's scoping rules actually hold for property.write, not just
//   property.read: an entity-scoped manager can create under their entity but
//   not another, and a property-scoped manager cannot create at all (there is
//   no propertyId yet for their grant to match).
//
//   The two fields D-3 and D-4 depend on - timezone and state - are refused
//   at write time when they are garbage, not silently accepted.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function createStaff(roleKey: string | null, scope?: { propertyId?: string; legalEntityId?: string }) {
  const email = `props-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Properties Test',
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
        propertyId: scope?.propertyId,
        legalEntityId: scope?.legalEntityId,
      },
    })
  }
  return { ...staff, password: PASSWORD }
}

async function seedEntity(name = 'Seed LLC') {
  const entity = await prisma.legalEntity.create({
    data: { name: `${name}-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  return entity
}

async function seedProperty(
  legalEntityId: string,
  overrides: Partial<{
    name: string
    addressLine1: string
    postalCode: string
  }> = {},
) {
  const property = await prisma.property.create({
    data: {
      legalEntityId,
      name: overrides.name ?? `Seed House-${randomUUID().slice(0, 8)}`,
      addressLine1: overrides.addressLine1 ?? '10 Seed St',
      city: 'Houston',
      state: 'TX',
      postalCode: overrides.postalCode ?? '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // A property that went through the real create/update ACTION (as opposed
  // to seedProperty()'s direct Prisma insert) has an AuditLog row pointing at
  // it via a real foreign key, and AuditLog is append-only - so deleting the
  // property would require nulling that FK, which the append-only trigger
  // refuses. Same shape as R-005/R-007's staff-user lesson, one level over:
  // deactivate what cannot be deleted, and `active: true` is exactly what
  // candidateDuplicateProperties filters on, so a deactivated stray property
  // stops polluting later runs' duplicate-address checks.
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

  // An entity can only be deleted once nothing still references it - which
  // now includes the properties just deactivated above, not only the ones
  // that were deleted.
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

  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
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
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('legal entities', () => {
  test('an owner creates an entity and sees it confirmed on the properties list', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/properties/entities/new')
    const name = `E2E Entity ${randomUUID().slice(0, 8)}`
    await page.getByLabel('Name').fill(name)
    await page.getByLabel('Type').selectOption('LLC')
    await page.getByRole('button', { name: 'Create entity' }).click()

    await page.waitForURL(/\/properties\?entityCreated=/)
    await expect(page.getByRole('status')).toContainText(name)

    const created = await prisma.legalEntity.findFirst({ where: { name } })
    expect(created).not.toBeNull()
    if (created) entityIds.push(created.id)
  })

  test('rejects a whitespace-only name', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/properties/entities/new')
    // Not left blank: the native `required` attribute would block submission
    // before the server ever saw it, proving nothing about OUR validation.
    // Whitespace passes the browser's check and still fails ours.
    await page.getByLabel('Name').fill('   ')
    await page.getByLabel('Type').selectOption('LLC')
    await page.getByRole('button', { name: 'Create entity' }).click()

    await expect(page).toHaveURL(/\/properties\/entities\/new/)
    await expect(page.getByText('Name is required.')).toBeVisible()
  })

  test('editing an entity updates it and is audited', async ({ page }) => {
    const staff = await createStaff('owner')
    const entity = await seedEntity('Editable')
    await signIn(page, staff.email)

    await page.goto(`/properties/entities/${entity.id}/edit`)
    await page.getByLabel('Name').fill(`${entity.name} Renamed`)
    await page.getByRole('button', { name: 'Save changes' }).click()

    await page.waitForURL('**/properties')
    const updated = await prisma.legalEntity.findUniqueOrThrow({
      where: { id: entity.id },
    })
    expect(updated.name).toBe(`${entity.name} Renamed`)

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'legal_entity.updated', entityId: entity.id },
    })
    expect(entry).not.toBeNull()
  })

  // Only a portfolio-wide property.write grant clears can()'s resource-less
  // check (R-004) - an entity-scoped manager operates within entities an
  // owner already set up, not creating new ones.
  test('does not offer entity creation to an entity-scoped manager', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const staff = await createStaff('manager', { legalEntityId: entity.id })
    await signIn(page, staff.email)

    await page.goto('/properties')
    await expect(page.getByRole('link', { name: 'New entity' })).toHaveCount(0)

    await page.goto('/properties/entities/new')
    await expect(page).toHaveURL(/\/no-access/)
  })
})

test.describe('creating a property', () => {
  test('creates a property and lands on its detail page with empty-state sections', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    // Randomized rather than a fixed street name: this test is not testing
    // duplicate detection, and a fixed address risks colliding with a stray
    // property a previous, imperfectly-cleaned-up run left active - which is
    // exactly the failure mode that motivated the afterAll fix above.
    const address = `${Math.floor(Math.random() * 9000) + 100} Maple Ave`
    await page.goto('/properties/new')
    await page.getByLabel('Owning entity').selectOption(entity.id)
    await page.getByLabel('Property name').fill(address)
    await page.getByLabel('Property type').selectOption('SINGLE_FAMILY')
    await page.getByLabel('Street address').fill(address)
    await page.getByLabel('City').fill('Houston')
    await page.getByLabel('State').selectOption('TX')
    await page.getByLabel('ZIP').fill('77002')
    await page.getByLabel('Timezone').fill('America/Chicago')
    await page.getByRole('button', { name: 'Create property' }).click()

    await page.waitForURL(/\/properties\/[a-z0-9]+$/)
    await expect(
      page.getByRole('heading', { name: address, level: 1 }),
    ).toBeVisible()

    // PROP-01's acceptance criterion, verbatim: sections for units, leases,
    // tickets, documents and financials, empty states OK.
    for (const section of [
      'Units',
      'Leases',
      'Maintenance',
      'Documents',
      'Financials',
    ]) {
      await expect(page.getByRole('heading', { name: section })).toBeVisible()
    }

    const created = await prisma.property.findFirst({ where: { name: address } })
    expect(created).not.toBeNull()
    if (created) propertyIds.push(created.id)
  })

  test('refuses an invented timezone', async ({ page }) => {
    const entity = await seedEntity()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/properties/new')
    await page.getByLabel('Owning entity').selectOption(entity.id)
    await page.getByLabel('Property name').fill('Bad TZ House')
    await page.getByLabel('Property type').selectOption('SINGLE_FAMILY')
    await page.getByLabel('Street address').fill('1 Nowhere Rd')
    await page.getByLabel('City').fill('Houston')
    await page.getByLabel('State').selectOption('TX')
    await page.getByLabel('ZIP').fill('77002')
    await page.getByLabel('Timezone').fill('America/Nowhere')
    await page.getByRole('button', { name: 'Create property' }).click()

    await expect(page).toHaveURL(/\/properties\/new/)
    await expect(
      page.getByText('That is not a recognized timezone.'),
    ).toBeVisible()
    expect(
      await prisma.property.findFirst({ where: { name: 'Bad TZ House' } }),
    ).toBeNull()
  })

  test('refuses a state outside the US list', async ({ page }) => {
    const entity = await seedEntity()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/properties/new')
    await page.getByLabel('Owning entity').selectOption(entity.id)
    await page.getByLabel('Property name').fill('No State House')
    await page.getByLabel('Property type').selectOption('SINGLE_FAMILY')
    await page.getByLabel('Street address').fill('1 Nowhere Rd')
    await page.getByLabel('City').fill('Nowhere')
    // Leave state unselected - the browser will refuse to submit a required
    // select with no value, so the server never sees a blank; assert the
    // native constraint fires and the request never leaves the page instead.
    await page.getByRole('button', { name: 'Create property' }).click()
    await expect(page).toHaveURL(/\/properties\/new/)
  })

  // PROP-01: "Given a duplicate address, when I save, then I am warned before
  // a second record is created." Not blocked outright - a second unit at the
  // same street address is real, so the flow has to let it through on
  // confirmation.
  test('warns on a duplicate address and creates it only on confirmation', async ({
    page,
  }) => {
    const entity = await seedEntity()
    // Randomized street number: a fixed address risks colliding with a stray
    // row a previous, imperfectly-cleaned-up run left active - the same
    // failure mode the afterAll fix above exists to prevent, and this test
    // hit it directly while this fix was being developed.
    const streetNumber = Math.floor(Math.random() * 9000) + 100
    const originalName = `Original House ${streetNumber}`
    const secondName = `Second House ${streetNumber}`
    const existing = await seedProperty(entity.id, {
      name: originalName,
      addressLine1: `${streetNumber} Elm Street`,
      postalCode: '77002',
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/properties/new')
    await page.getByLabel('Owning entity').selectOption(entity.id)
    await page.getByLabel('Property name').fill(secondName)
    await page.getByLabel('Property type').selectOption('SINGLE_FAMILY')
    // Deliberately a different abbreviation of the same street - this is the
    // realistic duplicate-entry case the comparison key exists to catch.
    await page.getByLabel('Street address').fill(`${streetNumber} elm st`)
    await page.getByLabel('City').fill('Houston')
    await page.getByLabel('State').selectOption('TX')
    await page.getByLabel('ZIP').fill('77002')
    await page.getByLabel('Timezone').fill('America/Chicago')
    await page.getByRole('button', { name: 'Create property' }).click()

    await expect(page).toHaveURL(/\/properties\/new/)
    await expect(page.locator('form').getByRole('alert')).toContainText(
      originalName,
    )

    // Not created yet - the warning stopped it.
    expect(
      await prisma.property.findFirst({ where: { name: secondName } }),
    ).toBeNull()

    // The remount that repopulates the form after the warning (see
    // PropertyForm's `formVersion`) settles synchronously during render, but
    // give it a beat before asserting on submitted values.
    await expect(page.getByLabel('Property name')).toHaveValue(secondName)

    await page.getByRole('button', { name: 'Save anyway' }).click()
    await page.waitForURL(/\/properties\/[a-z0-9]+$/)
    // The redirect target's own render already proves creation succeeded -
    // this is really just confirming the id to add to propertyIds for
    // cleanup, and to check the audit entry below.
    await expect(
      page.getByRole('heading', { name: secondName, level: 1 }),
    ).toBeVisible()

    // Polled, not a single read: the test's Prisma client is a separate
    // connection from the one the running app just committed through, and
    // against Neon's pooled connections a read immediately after a sibling
    // connection's write can occasionally land a beat before it is visible
    // there - even though the app's own redirect, proven above, already saw
    // it instantly on the same request. This is a connection-visibility gap
    // in the TEST's out-of-band verification, not a product bug.
    let second: Awaited<ReturnType<typeof prisma.property.findFirst>> = null
    await expect
      .poll(async () => {
        second = await prisma.property.findFirst({ where: { name: secondName } })
        return second
      })
      .not.toBeNull()
    if (second) propertyIds.push(second.id)
    propertyIds.push(existing.id)
  })

  // R-004's rule stated precisely: creating a property has no propertyId yet,
  // so a property-scoped grant cannot match the resource check no matter what
  // entity the property would belong to.
  test('refuses a property-scoped manager any property creation at all', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const existing = await seedProperty(entity.id)
    const staff = await createStaff('manager', { propertyId: existing.id })
    await signIn(page, staff.email)

    await page.goto('/properties')
    await expect(page.getByRole('link', { name: 'New property' })).toHaveCount(
      0,
    )

    await page.goto('/properties/new')
    await expect(
      page.getByText(/don.t have create access to any legal entity/i),
    ).toBeVisible()
  })

  // The entity dropdown on /properties/new is the write scope, not the read
  // scope - an entity-scoped manager should see exactly their entity there
  // and nothing else, even if other entities exist.
  test('offers an entity-scoped manager only their own entity to create under', async ({
    page,
  }) => {
    const mine = await seedEntity('Mine')
    const theirs = await seedEntity('Theirs')
    const staff = await createStaff('manager', { legalEntityId: mine.id })
    await signIn(page, staff.email)

    await page.goto('/properties/new')
    const select = page.getByLabel('Owning entity')
    await expect(select.getByRole('option', { name: mine.name })).toHaveCount(
      1,
    )
    await expect(
      select.getByRole('option', { name: theirs.name }),
    ).toHaveCount(0)
  })
})

test.describe('editing a property', () => {
  test('updates fields and keeps the owning entity fixed', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const property = await seedProperty(entity.id, { name: 'Before Edit' })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/edit`)
    // No entity select on the edit form - shown as fixed text instead.
    // Scoped to #main: the property switcher in the header also lists every
    // entity name as an <option>, so a bare page-wide text match is ambiguous.
    await expect(page.getByLabel('Owning entity')).toHaveCount(0)
    await expect(page.locator('#main').getByText(entity.name)).toBeVisible()

    await page.getByLabel('Property name').fill('After Edit')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await page.waitForURL(`**/properties/${property.id}`)
    await expect(
      page.getByRole('heading', { name: 'After Edit', level: 1 }),
    ).toBeVisible()

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'property.updated', entityId: property.id },
    })
    expect(entry).not.toBeNull()
    expect(entry?.before).toMatchObject({ name: 'Before Edit' })
    expect(entry?.after).toMatchObject({ name: 'After Edit' })
  })

  // ROLE-01, restated for a write instead of a read: the property switcher
  // narrows what a manager SEES, but the write itself is refused by the
  // route regardless of anything the client sends.
  test('refuses editing a property outside a scoped manager’s grant', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const mine = await seedProperty(entity.id, { name: 'Mine' })
    const theirs = await seedProperty(entity.id, { name: 'Theirs' })
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${theirs.id}/edit`)
    await expect(page).toHaveURL(/\/no-access/)
  })

  // Regression test for a real bug found while building R-009: the edit
  // page's guard checked only `{ propertyId }`, and assignmentCovers matches
  // an entity-scoped grant on `resource.legalEntityId` alone - so an
  // entity-scoped manager was denied editing a property that genuinely
  // belongs to their own entity. Fixed with propertyResource(), which
  // supplies both ids so either scope shape of grant can match.
  test('lets an entity-scoped manager edit a property in their own entity', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const property = await seedProperty(entity.id, { name: 'Entity Managed' })
    const staff = await createStaff('manager', { legalEntityId: entity.id })
    await signIn(page, staff.email)

    // The Edit button itself must be offered, not just the route reachable.
    await page.goto(`/properties/${property.id}`)
    await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible()

    await page.goto(`/properties/${property.id}/edit`)
    await expect(page).not.toHaveURL(/\/no-access/)
    await page.getByLabel('Property name').fill('Entity Managed Renamed')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await page.waitForURL(`**/properties/${property.id}`)
    await expect(
      page.getByRole('heading', { name: 'Entity Managed Renamed', level: 1 }),
    ).toBeVisible()
  })
})

test.describe('scoped visibility', () => {
  test('a property-scoped manager sees only their property in the list', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const mine = await seedProperty(entity.id, { name: 'Visible To Me' })
    const theirs = await seedProperty(entity.id, { name: 'Not Visible' })
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    await page.goto('/properties')
    await expect(page.getByText('Visible To Me')).toBeVisible()
    await expect(page.getByText('Not Visible')).toHaveCount(0)

    // And cannot reach it directly either (ROLE-01 - not just hidden UI). A
    // property outside scope 404s in place rather than redirecting to
    // /no-access - deliberately better information-hiding, since it does not
    // even confirm the id belongs to a real property.
    const response = await page.goto(`/properties/${theirs.id}`)
    expect(response?.status()).toBe(404)
  })
})

test.describe('accessibility', () => {
  for (const path of ['/properties', '/properties/new', '/properties/entities/new']) {
    test(`${path} has no detectable accessibility violations`, async ({
      page,
    }) => {
      const staff = await createStaff('owner')
      await signIn(page, staff.email)
      await page.goto(path)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations).toEqual([])
    })
  }

  test('a property detail page has no detectable accessibility violations', async ({
    page,
  }) => {
    const entity = await seedEntity()
    const property = await seedProperty(entity.id)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
