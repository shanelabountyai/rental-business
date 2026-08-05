import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Unit management (R-009, PROP-02). What matters beyond "the form works":
//
//   Units are scoped through their PROPERTY, not an entity of their own - the
//   same scoping shape as R-008's Ticket example, exercised here for real.
//
//   propertyResource() (the fix R-008 shipped mid-R-009, after this item's
//   own permission checks surfaced the gap) actually holds for units too: an
//   entity-scoped manager can manage units on a property in their entity.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []

async function createStaff(
  roleKey: string | null,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `units-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Units Test',
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

async function seedProperty(name = 'Seed House') {
  const entity = await prisma.legalEntity.create({
    data: { name: `Seed LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${name}-${randomUUID().slice(0, 8)}`,
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

async function seedUnit(propertyId: string, overrides: Partial<{ name: string; status: string }> = {}) {
  const unit = await prisma.unit.create({
    data: {
      propertyId,
      name: overrides.name ?? `Unit-${randomUUID().slice(0, 8)}`,
      status: (overrides.status ?? 'VACANT') as never,
    },
  })
  unitIds.push(unit.id)
  return unit
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Same lesson as properties.spec.ts: a unit created through the real
  // action carries an AuditLog row via a real FK, so it may need
  // deactivating rather than deleting. Unit has no `active` column though
  // (PROP-02 did not ask for unit archival) - so audited units are simply
  // left in place, and only their still-referencing PROPERTY is deactivated
  // rather than deleted.
  const auditedUnits = new Set(
    (
      await prisma.auditLog.findMany({
        where: { entityType: 'Unit', entityId: { in: unitIds } },
        select: { entityId: true },
      })
    ).map((row) => row.entityId),
  )
  await prisma.unit.deleteMany({
    where: { id: { in: unitIds.filter((id) => !auditedUnits.has(id)) } },
  })

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

test.describe('creating and viewing units', () => {
  test('adds a unit and shows it on the property detail page', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByRole('link', { name: 'Add unit' }).click()
    await page.waitForURL(`**/properties/${property.id}/units/new`)

    await page.getByLabel('Unit name').fill('ADU')
    await page.getByLabel('Status').selectOption('VACANT')
    await page.getByLabel('Market rent').fill('1500')
    await page.getByRole('button', { name: 'Create unit' }).click()

    await page.waitForURL(/\/properties\/[a-z0-9]+\/units\/[a-z0-9]+$/)
    await expect(page.getByRole('heading', { name: 'ADU', level: 1 })).toBeVisible()
    await expect(page.getByText('$1,500/mo')).toBeVisible()

    // PROP-02's empty-state sections, same convention as the property page.
    for (const section of ['Operational data', 'Lease', 'Maintenance']) {
      await expect(page.getByRole('heading', { name: section })).toBeVisible()
    }

    await page.goto(`/properties/${property.id}`)
    // Scoped to the units list row, not a bare getByText('ADU') - the
    // property switcher's own <option> list can legitimately contain
    // another property whose name happens to mention "ADU" too (an
    // ordinary thing for a property with an accessory dwelling to be
    // called), and unlike a visible list item, an <option> inside a closed
    // dropdown still counts as a DOM match.
    await expect(page.getByRole('listitem').filter({ hasText: 'ADU' })).toBeVisible()
    await expect(page.getByText('Vacant')).toBeVisible()

    const created = await prisma.unit.findFirst({ where: { propertyId: property.id, name: 'ADU' } })
    expect(created).not.toBeNull()
    if (created) unitIds.push(created.id)
  })

  test('rejects a whitespace-only name', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/new`)
    // Not left blank: the native `required` attribute blocks submission
    // before the server ever sees it, proving nothing about OUR validation
    // (same lesson as R-008's identical entity-name test). Whitespace passes
    // the browser's check and still fails ours.
    await page.getByLabel('Unit name').fill('   ')
    await page.getByLabel('Status').selectOption('VACANT')
    await page.getByRole('button', { name: 'Create unit' }).click()

    await expect(page).toHaveURL(/\/units\/new/)
    await expect(page.getByText(/Give the unit a name/)).toBeVisible()
  })

  test('shows an empty state when a property has no units yet', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await expect(page.getByText(/No units yet/)).toBeVisible()
  })
})

test.describe('editing a unit', () => {
  test('updates fields and is audited', async ({ page }) => {
    const { property } = await seedProperty()
    const unit = await seedUnit(property.id, { name: 'Before Edit', status: 'VACANT' })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}/edit`)
    await page.getByLabel('Unit name').fill('After Edit')
    await page.getByLabel('Status').selectOption('DOWN')
    await page.getByRole('button', { name: 'Save changes' }).click()

    await page.waitForURL(`**/properties/${property.id}/units/${unit.id}`)
    await expect(page.getByRole('heading', { name: 'After Edit', level: 1 })).toBeVisible()
    await expect(page.getByText('Down')).toBeVisible()

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'unit.updated', entityId: unit.id },
    })
    expect(entry).not.toBeNull()
    expect(entry?.before).toMatchObject({ name: 'Before Edit', status: 'VACANT' })
    expect(entry?.after).toMatchObject({ name: 'After Edit', status: 'DOWN' })
  })
})

test.describe('scoping (ROLE-01)', () => {
  test('a property-scoped manager can manage units on their property', async ({ page }) => {
    const { property } = await seedProperty()
    const unit = await seedUnit(property.id)
    const staff = await createStaff('manager', { propertyId: property.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    await expect(page).not.toHaveURL(/\/no-access/)
    await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible()
  })

  // Regression coverage for the propertyResource() bug R-008 fixed mid-R-009:
  // an entity-scoped manager must be able to reach and edit a unit on a
  // property that belongs to their own entity.
  test('an entity-scoped manager can manage units on a property in their entity', async ({
    page,
  }) => {
    const { entity, property } = await seedProperty()
    const unit = await seedUnit(property.id)
    const staff = await createStaff('manager', { legalEntityId: entity.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/${unit.id}/edit`)
    await expect(page).not.toHaveURL(/\/no-access/)
    await page.getByLabel('Unit name').fill('Entity Managed Unit')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForURL(`**/properties/${property.id}/units/${unit.id}`)
  })

  test('refuses a unit on a property outside a scoped manager’s grant', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const theirUnit = await seedUnit(theirs.id)
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    const response = await page.goto(`/properties/${theirs.id}/units/${theirUnit.id}`)
    expect(response?.status()).toBe(404)
  })

  test('does not offer unit creation to a manager without unit.write on this property', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${theirs.id}`)
    await expect(page.getByRole('link', { name: 'Add unit' })).toHaveCount(0)

    await page.goto(`/properties/${theirs.id}/units/new`)
    await expect(page).toHaveURL(/\/no-access/)
  })
})

test.describe('accessibility', () => {
  test('the new-unit and unit-detail pages have no detectable violations', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const unit = await seedUnit(property.id)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}/units/new`)
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])

    await page.goto(`/properties/${property.id}/units/${unit.id}`)
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
