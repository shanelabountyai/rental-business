import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Segment announcements (COMM-04, R-053) — "the city is flushing hydrants
// Tuesday". One message to a segment (all tenants / one property / one
// metro / one tag), with per-recipient delivery status.
//
// ==========================================================================
// THE ONE THING THIS FILE EXISTS TO PROVE: A SEGMENT REACHES ONLY WHAT IT
// NAMES. Two properties sit in the same manager's scope with different
// metros and tags; every targeted test below sends to one segment and
// checks the OTHER property's tenant got nothing — a segment silently
// broadcasting wider than it claims is the failure mode that matters here,
// the same way rent-roll.spec.ts exists to prove being late and being
// chaseable are different things.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const staffIds: string[] = []
const templateIds: string[] = []

async function seedTwoProperties() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Announce LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)

  async function property(label: string, metro: string, tags: string[]) {
    const p = await prisma.property.create({
      data: {
        legalEntityId: entity.id,
        name: `${label}-${stamp}`,
        addressLine1: `1 ${label} Ave`,
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
        metro,
        tags,
      },
    })
    propertyIds.push(p.id)
    const unit = await prisma.unit.create({
      data: { propertyId: p.id, name: `U-${stamp}-${label}`, status: 'OCCUPIED' },
    })
    unitIds.push(unit.id)
    const tenant = await prisma.tenant.create({
      data: {
        // STAMPED — see rent-roll.spec.ts's identical comment: an unstamped
        // name risks matching another test's row on this shared database.
        firstName: `${label}${stamp}`,
        lastName: `Announce-${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@example.test`,
        phone: uniquePhone(),
      },
    })
    tenantIds.push(tenant.id)
    const lease = await prisma.lease.create({
      data: {
        propertyId: p.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
      },
    })
    leaseIds.push(lease.id)
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
    await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId: p.id,
        payerType: 'TENANT',
        tenantId: tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
    return { property: p, tenant, lease }
  }

  const a = await property('Downtown', 'Metro-A', ['downtown'])
  const b = await property('Suburb', 'Metro-B', ['suburb'])
  return { entity, a, b }
}

/// ENTITY-scoped, not property-scoped — one manager has to see BOTH seeded
/// properties, or segment filtering has nothing to distinguish. `manager`
/// holds `message.send` and it is not privileged, so no MFA.
async function seedScopedManager(legalEntityId: string) {
  const email = `announce-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Announcements Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId },
  })
  return staff
}

async function seedTemplate(staffId: string) {
  const template = await prisma.messageTemplate.create({
    data: {
      name: `Hydrant flushing ${randomUUID().slice(0, 6)}`,
      kind: 'ROUTINE',
      subject: 'Hydrant flushing Tuesday',
      body: 'Hi {{tenant.first_name}}, the city is flushing hydrants near {{property.address}} Tuesday.',
      createdByStaffId: staffId,
    },
  })
  templateIds.push(template.id)
  return template
}

/// Portfolio-wide, for the accessibility scan below — the page has to render
/// with no seeded segment data to be a fair scan of its empty states.
async function seedOwner() {
  const email = `announce-owner-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Announcements Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.describe('segment announcements (COMM-04)', () => {
  test('ALL TENANTS reaches every property in scope', async ({ page }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')

    // "All tenants" is the default — no segment value picker to fill in.
    await page.getByLabel('Template').selectOption(template.id)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Sent to 2 tenants/)).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(a.tenant.firstName) }),
    ).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(b.tenant.firstName) }),
    ).toBeVisible()
  })

  test('ONE PROPERTY reaches only that property, not the other in scope', async ({
    page,
  }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')

    await page.getByLabel('Send to').selectOption('PROPERTY')
    // Anchored regex, not { exact: true } — SelectField renders a required
    // field's label as "Property *", so an exact match against "Property"
    // never matches anything. Anchoring to the start still rules out the
    // global property/entity switcher, whose label ("Filter by property or
    // entity") does not start with "Property".
    await page.getByLabel(/^Property\b/).selectOption(a.property.id)
    await page.getByLabel('Template').selectOption(template.id)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(a.tenant.firstName) }),
    ).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(b.tenant.firstName) }),
    ).toHaveCount(0)

    // Not just absent from the table — never even attempted.
    const delivery = await prisma.notificationDelivery.findFirst({
      where: {
        notification: { recipientId: b.tenant.id, templateKey: 'comms.announcement' },
      },
    })
    expect(delivery).toBeNull()
  })

  test('ONE METRO reaches only the property in that metro', async ({ page }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')

    await page.getByLabel('Send to').selectOption('METRO')
    await page.getByLabel(/^Metro\b/).selectOption(a.property.metro!)
    await page.getByLabel('Template').selectOption(template.id)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(a.tenant.firstName) }),
    ).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(b.tenant.firstName) }),
    ).toHaveCount(0)
  })

  test('ONE TAG reaches only the property carrying that tag', async ({ page }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')

    await page.getByLabel('Send to').selectOption('TAG')
    await page.getByLabel(/^Tag\b/).selectOption(a.property.tags[0])
    await page.getByLabel('Template').selectOption(template.id)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(a.tenant.firstName) }),
    ).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(b.tenant.firstName) }),
    ).toHaveCount(0)
  })

  test('DOUBLE-PRESSING SENDS ONCE', async ({ page }) => {
    const { entity, a } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await page.getByLabel('Send to').selectOption('PROPERTY')
    await page.getByLabel(/^Property\b/).selectOption(a.property.id)
    await page.getByLabel('Template').selectOption(template.id)

    const countRows = () =>
      prisma.notification.count({
        where: { recipientId: a.tenant.id, templateKey: 'comms.announcement' },
      })

    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    const afterFirst = await countRows()

    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    const afterSecond = await countRows()

    // COMPARED AGAINST ITSELF, not against 1 — one logical send is already
    // one row per CHANNEL. What must hold is that the second press adds
    // nothing (same reasoning as rent-roll.spec.ts's identical test).
    expect(afterFirst).toBeGreaterThan(0)
    expect(afterSecond).toBe(afterFirst)
  })
})

test.describe('accessibility', () => {
  test('/messages/announcements has no detectable accessibility violations', async ({
    page,
  }) => {
    const staff = await seedOwner()
    await signIn(page, staff)
    await page.goto('/messages/announcements')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('the segment-value picker and its results table stay accessible', async ({
    page,
  }) => {
    const { entity, a } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await page.getByLabel('Send to').selectOption('PROPERTY')
    await page.getByLabel(/^Property\b/).selectOption(a.property.id)
    await page.getByLabel('Template').selectOption(template.id)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})

test.afterAll(async () => {
  await prisma.messageTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.lease.updateMany({
    where: { id: { in: leaseIds } },
    data: { status: 'ENDED' },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})
