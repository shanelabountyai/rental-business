import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The emergency intake path (MAINT-01's emergency criterion, PROP-03, R-020).
//
// The assertions that matter here are safety assertions, not rendering ones:
// that a gas smell is told to leave and call 911 BEFORE anything else, that
// it is never sent hunting for a shutoff, that the ticket lands as EMERGENCY,
// and that somebody is actually paged - at whatever hour.

const propertyIds: string[] = []
const entityIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const staffIds: string[] = []
const documentIds: string[] = []

async function seedEmergencyTenancy() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Emg LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Emg House-${randomUUID().slice(0, 8)}`,
      addressLine1: '31 Cedar Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Rae',
      lastName: `Emergency-${randomUUID().slice(0, 6)}`,
      phone: '+15125550188',
    },
  })
  tenantIds.push(tenant.id)

  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: `U-${randomUUID().slice(0, 6)}`,
      status: 'OCCUPIED',
    },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id },
  })

  // R-014's unit record: the shutoff locations the emergency screen surfaces.
  await prisma.shutoffLocation.createMany({
    data: [
      {
        unitId: unit.id,
        type: 'WATER_MAIN',
        description: 'Left side of the house, under the hose bib.',
      },
      { unitId: unit.id, type: 'GAS', description: 'At the meter, street side.' },
    ],
  })

  // An on-call recipient - anyone holding ticket.write on the property.
  const staff = await prisma.staffUser.create({
    data: {
      email: `emg-oncall-${randomUUID()}@example.test`,
      name: 'On Call',
      phone: '+15125550199',
      credential: {
        create: { passwordHash: await hashPassword('correct-horse-battery-staple') },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId: property.id },
  })

  return { property, tenant, unit, staff }
}

async function magicLinkFor(tenantId: string) {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  // The `ticket.created` events this spec emits. R-019's UnroutedMessage
  // lesson, again: apps/web/lib/jobs/jobs.test.ts calls dispatchOutbox()
  // GLOBALLY and oldest-first with a batch limit, so events left pending by
  // one suite are shared state another suite has to wade through. Nothing
  // consumes ticket.created yet (R-023 will), so these would otherwise sit
  // pending forever.
  await prisma.eventConsumption.deleteMany({
    where: { event: { propertyId: { in: propertyIds } } },
  })
  await prisma.outboxEvent.deleteMany({
    where: { propertyId: { in: propertyIds } },
  })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  // Notification is append-only, so staff who were paged cannot be deleted.
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
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

test.describe('safety-first instructions', () => {
  test('tells a gas-smell reporter to leave and call 911, and never offers a shutoff', async ({
    page,
  }) => {
    // The single most important test in this file. The unit record HAS a gas
    // shutoff on file; the screen must still not send them looking for it.
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')

    await expect(page.getByText(/call 911 first/i)).toBeVisible()
    await page.getByRole('button', { name: 'I smell gas' }).click()

    await expect(page.getByRole('heading', { name: 'Do this now' })).toBeVisible()
    await expect(page.getByText(/Leave the home now/i)).toBeVisible()
    await expect(page.getByText(/call 911 and your gas company/i)).toBeVisible()

    // No shutoff section at all - not an empty one.
    await expect(page.getByRole('heading', { name: /shutoff/i })).toHaveCount(0)
    await expect(page.getByText('At the meter, street side.')).toHaveCount(0)
  })

  test('surfaces the water shutoff from the unit record for flooding', async ({
    page,
  }) => {
    // MAINT-01: "the relevant shutoff photo/location from the unit record
    // displays". This is R-014's data reaching the tenant at the moment it
    // matters.
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')

    await page.getByRole('button', { name: 'Water is flooding in right now' }).click()
    await expect(page.getByRole('heading', { name: 'Your water shutoff' })).toBeVisible()
    await expect(page.getByText('Left side of the house, under the hose bib.')).toBeVisible()
  })

  test('says so honestly when no shutoff is on file', async ({ page }) => {
    const { tenant, unit } = await seedEmergencyTenancy()
    await prisma.shutoffLocation.deleteMany({ where: { unitId: unit.id } })

    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')
    await page.getByRole('button', { name: 'Water is flooding in right now' }).click()

    await expect(page.getByText(/do not have this recorded/i)).toBeVisible()
  })

  test('lets a tenant see their own shutoff photo (R-020 access exception)', async ({
    page,
  }) => {
    const { tenant, property, unit } = await seedEmergencyTenancy()
    const photo = await prisma.document.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        type: 'SHUTOFF_PHOTO',
        fileName: 'water-main.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 5,
        storageKey: `emg-test/${randomUUID()}`,
      },
    })
    documentIds.push(photo.id)

    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')
    await page.getByRole('button', { name: 'Water is flooding in right now' }).click()

    const link = page.getByRole('link', { name: 'See the photo' })
    await expect(link).toBeVisible()

    // The bytes are 404 (nothing on disk for this fixture), but the
    // AUTHORIZATION must pass - a 404 from the storage layer, not a redirect
    // to sign-in or a refusal from the access rule. Before R-020 this route
    // refused a tenant outright.
    const response = await page.request.get(`/api/documents/${photo.id}/file`)
    expect(response.status()).not.toBe(302)
    expect(response.status()).not.toBe(307)
  })
})

test.describe('submitting an emergency', () => {
  test('creates an EMERGENCY ticket and pages on-call immediately', async ({
    page,
  }) => {
    const { tenant, staff } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')

    await page.getByRole('button', { name: 'Sewage is backing up' }).click()
    await expect(page.getByText(/Stop running water/i)).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()

    await page
      .getByRole('group', { name: /Can we come in/i })
      .getByRole('button', { name: 'Yes' })
      .click()
    await page
      .getByRole('group', { name: /pet at home/i })
      .getByRole('button', { name: 'No' })
      .click()
    await page.getByRole('button', { name: 'Send now' }).click()

    await page.waitForURL(/\/portal\/maintenance\/[a-z0-9]+\?emergency=1$/)
    await expect(page.getByText(/We have paged someone now/i)).toBeVisible()

    await expect
      .poll(() => prisma.ticket.count({ where: { tenantId: tenant.id } }), {
        timeout: 10_000,
      })
      .toBe(1)
    const ticket = await prisma.ticket.findFirstOrThrow({
      where: { tenantId: tenant.id },
    })
    ticketIds.push(ticket.id)

    expect(ticket.priority).toBe('EMERGENCY')
    expect(ticket.category).toBe('SEWAGE_BACKUP')
    // Every emergency category is a habitability matter by definition.
    expect(ticket.habitabilityFlag).toBe(true)
    expect(ticket.entryPermission).toBe(true)
    expect(ticket.description).toContain('EMERGENCY: Sewage is backing up.')

    // The page itself - decided AND sent in the same request, not queued for
    // the hourly cron.
    await expect
      .poll(
        async () =>
          prisma.notification.count({
            where: {
              category: 'maintenance_emergency',
              recipientId: staff.id,
            },
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0)

    const paged = await prisma.notification.findMany({
      where: { category: 'maintenance_emergency', recipientId: staff.id },
      include: { delivery: true },
    })
    // Never DEFERRED: maintenance_emergency bypasses quiet hours, which is
    // what makes "regardless of hour" true rather than merely intended.
    for (const notification of paged) {
      expect(notification.delivery?.status).not.toBe('DEFERRED')
    }
    // SMS is the channel that actually wakes somebody up, and it leads with
    // the word EMERGENCY so a lock-screen preview is enough to act on.
    const sms = paged.find((n) => n.channel === 'SMS')
    expect(sms?.body.startsWith('EMERGENCY:')).toBe(true)
    expect(sms?.body).toContain('31 Cedar Court')
    expect(sms?.body).toContain('+15125550188')
  })

  test('records the submission in the audit trail', async ({ page }) => {
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')

    await page.getByRole('button', { name: /carbon monoxide/i }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page
      .getByRole('group', { name: /Can we come in/i })
      .getByRole('button', { name: 'No' })
      .click()
    await page
      .getByRole('group', { name: /pet at home/i })
      .getByRole('button', { name: 'Yes' })
      .click()
    await page.getByRole('button', { name: 'Send now' }).click()
    await page.waitForURL(/\/portal\/maintenance\//)

    await expect
      .poll(() => prisma.ticket.count({ where: { tenantId: tenant.id } }), {
        timeout: 10_000,
      })
      .toBe(1)
    const ticket = await prisma.ticket.findFirstOrThrow({
      where: { tenantId: tenant.id },
    })
    ticketIds.push(ticket.id)

    const entry = await prisma.auditLog.findFirst({
      where: {
        entityType: 'Ticket',
        entityId: ticket.id,
        action: 'ticket.submitted',
      },
    })
    expect(entry).not.toBeNull()
  })

  test('will not submit without an entry and pet answer', async ({ page }) => {
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')

    await page.getByRole('button', { name: 'A break-in, or a door or window will not secure' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    const send = page.getByRole('button', { name: 'Send now' })
    await expect(send).toBeDisabled()

    await page
      .getByRole('group', { name: /Can we come in/i })
      .getByRole('button', { name: 'Yes' })
      .click()
    await expect(send).toBeDisabled()

    await page
      .getByRole('group', { name: /pet at home/i })
      .getByRole('button', { name: 'No' })
      .click()
    await expect(send).toBeEnabled()
  })
})

test.describe('reaching the emergency path', () => {
  test('is the first thing on the maintenance screen', async ({ page }) => {
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance')

    await expect(
      page.getByRole('link', { name: /Emergency — gas, flooding/i }),
    ).toBeVisible()
  })

  test('offers an escape hatch from the ordinary flow', async ({ page }) => {
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/new')

    await expect(
      page.getByRole('link', { name: /Is this an emergency/i }),
    ).toBeVisible()
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('the emergency screens have no detectable violations', async ({ page }) => {
    const { tenant } = await seedEmergencyTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/maintenance/emergency')

    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'category screen').toEqual([])

    // The safety screen uses red heavily - exactly where a contrast failure
    // would be most costly, on the screen somebody reads under stress.
    await page.getByRole('button', { name: 'Water is flooding in right now' }).click()
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'safety screen').toEqual([])

    await page.getByRole('button', { name: 'Continue' }).click()
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'details screen').toEqual([])
  })
})
