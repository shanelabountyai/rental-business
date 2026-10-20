import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { businessDate, wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniquePhone } from './fixtures.ts'

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

/// Step one (R-259): pick the segment and load its reviewed list. A GET, so
/// the URL changing is the signal the list is the new one.
async function chooseRecipients(
  page: import('@playwright/test').Page,
  segment: string | undefined,
  templateId: string,
) {
  await page.getByLabel('Message', { exact: true }).selectOption(templateId)
  if (segment) await page.getByLabel('Send to').selectOption(segment)
  await page.getByRole('button', { name: 'Choose recipients' }).click()
  await page.waitForURL(/[?&]templateId=/)
  await expect(page.getByRole('group', { name: 'Who gets this?' })).toBeVisible()
}

const audienceNames: string[] = []

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
    await chooseRecipients(page, undefined, template.id)
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

    // ONE control now (R-115): the segment type and its value are a single
    // `TYPE:value` option, because the value dropdown used to exist only
    // while client state said so - so before hydration the only segment
    // anybody could send to was the default, "All tenants".
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)
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

    await chooseRecipients(page, `METRO:${a.property.metro!}`, template.id)
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

    await chooseRecipients(page, `TAG:${a.property.tags[0]}`, template.id)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(a.tenant.firstName) }),
    ).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(b.tenant.firstName) }),
    ).toHaveCount(0)
  })

  test('BALANCE DUE reaches only the tenancy that owes, and the picker said so first', async ({
    page,
  }) => {
    const { entity, a, b } = await seedTwoProperties()
    // A fixture charge, as deposits.spec.ts does: the balance is what the
    // segment reads, and where the row came from is not this spec's subject.
    await prisma.ledgerEntry.create({
      data: {
        propertyId: a.property.id,
        leaseId: a.lease.id,
        type: 'CHARGE',
        amountCents: 150_000,
        description: 'October rent',
        occurredAt: new Date('2026-10-01T00:00:00Z'),
      },
    })
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')

    // R-258: the count and the send come from one predicate, so the option
    // must already say 1 before anything is pressed.
    await expect(page.locator('option[value="BALANCE_DUE"]')).toHaveText('Balance due — 1 tenant')
    // A "Property · Unit" label is the widest option this select has held,
    // and a native select is as wide as its widest option (R-170a, R-182).
    const width = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ])
    expect(width[0]).toBeLessThanOrEqual(width[1]!)

    await chooseRecipients(page, 'BALANCE_DUE', template.id)
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    await expect(
      page.getByRole('row', { name: new RegExp(a.tenant.firstName) }),
    ).toBeVisible()
    const delivery = await prisma.notificationDelivery.findFirst({
      where: {
        notification: { recipientId: b.tenant.id, templateKey: 'comms.announcement' },
      },
    })
    expect(delivery).toBeNull()
  })

  test('DOUBLE-PRESSING SENDS ONCE', async ({ page }) => {
    const { entity, a } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)

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

test.describe('reviewed recipients and saved audiences (R-259)', () => {
  test('UNTICKING A RECIPIENT LEAVES THEM OUT, and the audit names them', async ({ page }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, undefined, template.id)

    await page.getByRole('checkbox', { name: new RegExp(b.tenant.firstName) }).uncheck()
    // The live count is client state; the button's label is what proves the
    // untick was seen before the press.
    await expect(page.getByRole('button', { name: 'Send to 1 tenant' })).toBeVisible()
    await page.getByRole('button', { name: 'Send to 1 tenant' }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    await expect(page.getByRole('row', { name: new RegExp(a.tenant.firstName) })).toBeVisible()
    const delivery = await prisma.notificationDelivery.findFirst({
      where: { notification: { recipientId: b.tenant.id, templateKey: 'comms.announcement' } },
    })
    expect(delivery).toBeNull()

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'message.announcement_sent', entityId: template.id },
    })
    expect((row.after as { removedLeaseIds: string[] }).removedLeaseIds).toEqual([b.lease.id])
  })

  test('A POSTED ID OUTSIDE THE SEGMENT IS DROPPED, never trusted', async ({ page }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)

    // A hand-made POST: b is in the manager's scope but not in the segment.
    await page.locator('input[name="leaseIds"]').first().evaluate((input, id) => {
      const field = input as HTMLInputElement
      const extra = field.cloneNode() as HTMLInputElement
      extra.value = id
      field.form!.append(extra)
    }, b.lease.id)
    await page.getByRole('button', { name: /^Send to/ }).click()

    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()
    const delivery = await prisma.notificationDelivery.findFirst({
      where: { notification: { recipientId: b.tenant.id, templateKey: 'comms.announcement' } },
    })
    expect(delivery).toBeNull()
  })

  test('the PREVIEW shows the first recipient\'s text and a segment estimate before anything is sent', async ({
    page,
  }) => {
    const { entity, a } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)

    const preview = page.getByRole('region', { name: 'Preview' })
    await expect(preview.getByText(`Hi ${a.tenant.firstName}, the city is flushing`)).toBeVisible()
    await expect(preview.getByText(/up to 1 segment each \(GSM-7\)/)).toBeVisible()
  })

  test('a body over 1,600 characters is BLOCKED in the preview and refused by the send', async ({
    page,
  }) => {
    const { entity, a } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await prisma.messageTemplate.create({
      data: {
        name: `Too long ${randomUUID().slice(0, 6)}`,
        kind: 'ROUTINE',
        subject: 'Long',
        body: `Hi {{tenant.first_name}}, ${'word '.repeat(340)}`,
        createdByStaffId: staff.id,
      },
    })
    templateIds.push(template.id)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)

    await expect(page.getByText('This cannot be sent yet:')).toBeVisible()
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(/Not sent\. The message is over 1600 characters/)).toBeVisible()
    expect(
      await prisma.notificationDelivery.count({
        where: { notification: { recipientId: a.tenant.id, templateKey: 'comms.announcement' } },
      }),
    ).toBe(0)
  })

  test('SCHEDULED FOR 9AM TOMORROW holds every text to that property-local instant, lists it, and Cancel suppresses it', async ({
    page,
  }) => {
    const { entity, a, b } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)
    // 36h ahead so the date's 09:00 is in the future whatever the hour now.
    const day = businessDate(new Date(Date.now() + 36 * 60 * 60 * 1000), 'America/Chicago')
    const sendAt = `${day}T09:00`
    const instant = wallClockToUtc(sendAt, 'America/Chicago')

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, undefined, template.id)
    await page.getByLabel('Send at').fill(sendAt)
    await page.getByRole('button', { name: 'Schedule for 2 tenants' }).click()
    await expect(page.getByText(/^Scheduled for .* to 2 tenants\./)).toBeVisible()

    // A channel the engine suppresses anyway (no SMS consent on this fixture)
    // is still SUPPRESSED; what the schedule owns is every delivery that
    // WOULD have gone, and none of those may be queued or sent yet.
    const held: string[] = []
    for (const tenant of [a.tenant, b.tenant]) {
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notification: { recipientId: tenant.id, templateKey: 'comms.announcement' } },
      })
      const deferred = deliveries.filter((d) => d.status === 'DEFERRED')
      expect(deferred.length).toBeGreaterThan(0)
      expect(deliveries.filter((d) => d.status === 'QUEUED' || d.status === 'SENT')).toEqual([])
      for (const d of deferred) {
        expect(d.sendAfter?.toISOString()).toBe(instant.toISOString())
        held.push(d.id)
      }
    }

    const schedule = await prisma.announcementSchedule.findFirstOrThrow({
      where: { templateId: template.id, sendAt },
    })
    expect(schedule.recipientCount).toBe(2)

    await page.goto('/messages/announcements')
    await page
      .getByRole('button', { name: `Cancel scheduled announcement ${template.name}` })
      .click()
    // Poll the action's LAST write (the audit row), not its first: the
    // suppress and the stamp land before it, so once it exists they have too.
    await expect
      .poll(async () =>
        prisma.auditLog.findFirst({
          where: { action: 'message.announcement_cancelled', entityId: template.id },
        }),
      )
      .not.toBeNull()
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'message.announcement_cancelled', entityId: template.id },
    })
    expect((row.after as { scheduleId: string }).scheduleId).toBe(schedule.id)
    expect(
      (await prisma.announcementSchedule.findUniqueOrThrow({ where: { id: schedule.id } }))
        .cancelledAt,
    ).not.toBeNull()
    const after = await prisma.notificationDelivery.findMany({ where: { id: { in: held } } })
    expect(after.length).toBe(held.length)
    expect(after.every((d) => d.status === 'SUPPRESSED' && d.suppressedReason === 'cancelled')).toBe(
      true,
    )
  })

  test('A SAVED AUDIENCE is a filter in the Send to list, with a live count, and can be removed', async ({
    page,
  }) => {
    const { entity, a } = await seedTwoProperties()
    const staff = await seedScopedManager(entity.id)
    const template = await seedTemplate(staff.id)
    const name = `Downtown only ${randomUUID().slice(0, 8)}`
    audienceNames.push(name)

    await signIn(page, staff)
    await page.goto('/messages/announcements')
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)

    await page.getByLabel('Save this filter as an audience').fill(name)
    await page.getByRole('button', { name: 'Save audience' }).click()
    await expect(page.getByText(`Saved "${name}".`)).toBeVisible()

    const saved = await prisma.audience.findFirstOrThrow({ where: { name } })
    expect(saved.segment).toBe(`PROPERTY:${a.property.id}`)

    await page.goto('/messages/announcements')
    await expect(
      page.locator('optgroup[label="Saved audiences"] option', { hasText: name }),
    ).toHaveText(`${name} — 1 tenant`)

    await page.getByRole('button', { name: `Remove saved audience ${name}` }).click()
    await expect.poll(async () => (await prisma.audience.findUniqueOrThrow({ where: { id: saved.id } })).active).toBe(false)
    await page.reload()
    await expect(page.locator('option', { hasText: name })).toHaveCount(0)
  })
})

test.describe('accessibility', () => {
  test('/messages/announcements has no detectable accessibility violations', async ({
    page,
  }) => {
    const staff = await seedOwner()
    await signIn(page, staff)
    await page.goto('/messages/announcements')

    const results = await axeScan(page)
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
    await chooseRecipients(page, `PROPERTY:${a.property.id}`, template.id)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByText(/Sent to 1 tenant/)).toBeVisible()

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})

test.afterAll(async () => {
  await prisma.audience.updateMany({ where: { name: { in: audienceNames } }, data: { active: false } })
  // R-261: a schedule points at its template, so it goes first.
  await prisma.announcementSchedule.deleteMany({ where: { templateId: { in: templateIds } } })
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
