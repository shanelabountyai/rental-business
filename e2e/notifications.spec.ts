import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The notification engine through the UI (NOTIF-01's central log, NOTIF-02's
// per-category preferences).
//
// Neither screen is behind a privileged permission - `message.read` is a read
// and preferences are the actor's own - so every test here signs in plainly,
// unlike R-012's document-delete and R-014's code-reveal suites.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `notifications-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Notifications Test',
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

/// Writes a Notification directly rather than driving `notify()`, because
/// these tests are about the SCREENS. The engine's own guarantees are proved
/// against a real database in apps/web/lib/notifications/notifications.test.ts.
async function seedNotification(
  propertyId: string,
  overrides: {
    category?: string
    status?: 'SENT' | 'SUPPRESSED' | 'DEFERRED' | 'FAILED'
    suppressedReason?: string
    subject?: string
  } = {},
) {
  return prisma.notification.create({
    data: {
      idempotencyKey: `e2e:${randomUUID()}`,
      category: overrides.category ?? 'unit_make_ready',
      channel: 'EMAIL',
      recipientType: 'STAFF',
      recipientId: `e2e-${randomUUID()}`,
      toAddress: 'ops@example.test',
      templateKey: 'unit.make_ready',
      subject: overrides.subject ?? 'ADU is ready to turn',
      body: 'The lease ended without a renewal.',
      propertyId,
      delivery: {
        create: {
          status: overrides.status ?? 'SENT',
          suppressedReason: overrides.suppressedReason ?? null,
          sentAt: overrides.status === 'SENT' ? new Date() : null,
        },
      },
    },
  })
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Notification is append-only: its rows cannot be deleted, and its
  // propertyId FK is ON DELETE SET NULL, which is an UPDATE the trigger also
  // rejects. So the properties this file created are deactivated rather than
  // deleted - the same wall AuditLog already puts up, handled the same way in
  // every other spec.
  const notified = new Set(
    (
      await prisma.notification.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { propertyId: { in: propertyIds } } },
  })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  const undeletable = new Set([...notified, ...auditedProperties])
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !undeletable.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...undeletable] } },
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

  await prisma.notificationPreference.deleteMany({
    where: { recipientId: { in: staffIds } },
  })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
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

test.describe('the notification log', () => {
  test('shows a sent notification with its channel and address', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    await seedNotification(property.id, { subject: 'Turn the ADU' })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/notifications')
    const row = page.getByRole('listitem').filter({ hasText: 'Turn the ADU' })
    await expect(row).toBeVisible()
    await expect(row.getByText('Sent', { exact: true })).toBeVisible()
    await expect(row.getByText('ops@example.test')).toBeVisible()
  })

  test('explains a suppressed notification rather than hiding it', async ({
    page,
  }) => {
    // The whole reason suppressed sends are recorded: "why didn't they get
    // it" has to be answerable from the log itself.
    const { property } = await seedProperty()
    await seedNotification(property.id, {
      subject: 'Quiet one',
      status: 'SUPPRESSED',
      suppressedReason: 'preference_off',
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/notifications')
    const row = page.getByRole('listitem').filter({ hasText: 'Quiet one' })
    await expect(
      row.getByText('recipient turned this category off'),
    ).toBeVisible()
  })

  test('never shows a notification for a property outside the actor’s scope', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    await seedNotification(theirs.id, { subject: 'Not for you' })
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    await page.goto('/notifications')
    await expect(page.getByText('Not for you')).toHaveCount(0)
  })

  test('is hidden from a role without message.read', async ({ page }) => {
    // The guarantor role holds lease.read and ledger.read only.
    const staff = await createStaff('guarantor')
    await signIn(page, staff.email)

    await expect(
      page.getByRole('link', { name: 'Notifications', exact: true }),
    ).toHaveCount(0)

    // The URL, not the response status: `page.goto()` reports the status of
    // the page actually landed on after the redirect, and /no-access renders
    // a perfectly ordinary 200. Asserting on the status here is the exact
    // mistake R-012 already made and recorded.
    await page.goto('/notifications')
    await expect(page).toHaveURL(/\/no-access/)
    // Names the permission, so the person can ask for the right thing.
    await expect(page.getByText('message.read')).toBeVisible()
  })
})

test.describe('notification preferences (NOTIF-02)', () => {
  test('turns a category off and stores the override', async ({ page }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/account')
    // BY ITS ID, not by filtering list items on "Rent reminders".
    //
    // `hasText` is a case-insensitive SUBSTRING match, and the daily-digest
    // row's own label spells out what it replaces — "(rent reminders,
    // maintenance updates, renewals, …)" — so the filter matches two list
    // items and the Email checkbox inside them resolves to two elements.
    // Latent since the digest category was given that explanatory label;
    // found by R-086, which was the first item to run this spec alongside
    // its own. The ids are deliberately constructed as
    // `pref-${category}-${channel}`, so this names exactly one control.
    const emailToggle = page.locator('#pref-rent_reminder-EMAIL')
    await expect(emailToggle).toBeChecked()

    // A Server Action form ships a placeholder action until hydration
    // attaches the real handler - the same race documented in
    // e2e/documents.spec.ts's restore test, and this form auto-submits on
    // change rather than waiting for a button press.
    await page.waitForTimeout(500)
    await emailToggle.uncheck()

    // expect.poll(), not a single read: the test's Prisma connection is not
    // the server's, and Neon's pooler does not guarantee it observes a
    // just-committed write immediately (R-008's documented lag).
    await expect
      .poll(
        async () =>
          (
            await prisma.notificationPreference.findFirst({
              where: {
                recipientId: staff.id,
                category: 'rent_reminder',
                channel: 'EMAIL',
              },
            })
          )?.enabled,
        { timeout: 10_000 },
      )
      .toBe(false)
  })

  test('locks legally-critical categories and explains why', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/account')
    const legal = page
      .getByRole('listitem')
      .filter({ hasText: 'Legal notices' })
    await expect(legal.getByText('Always on.')).toBeVisible()
    await expect(
      legal.getByText(/could invalidate a notice you are entitled to receive/),
    ).toBeVisible()
    // No control at all, not a disabled one - there is nothing to toggle.
    await expect(legal.getByRole('checkbox')).toHaveCount(0)
  })

  test('refuses a crafted submission that would silence a locked category', async ({
    page,
  }) => {
    // The screen renders no control for these, which is a courtesy. This is
    // the rule: a direct POST must be refused too, or the lock is decoration.
    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/account')

    const before = await prisma.notificationPreference.count({
      where: { recipientId: staff.id, category: 'legal_notice' },
    })
    expect(before).toBe(0)

    // Driven through the emergency-maintenance category, which is locked for
    // the same reason and equally has no rendered control.
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'Emergency maintenance' })
        .getByRole('checkbox'),
    ).toHaveCount(0)

    const after = await prisma.notificationPreference.count({
      where: {
        recipientId: staff.id,
        category: { in: ['legal_notice', 'maintenance_emergency'] },
      },
    })
    expect(after).toBe(0)
  })
})

test.describe('accessibility', () => {
  test('the notification log has no detectable violations', async ({ page }) => {
    const { property } = await seedProperty()
    await seedNotification(property.id)
    await seedNotification(property.id, {
      status: 'SUPPRESSED',
      suppressedReason: 'no_address',
      subject: 'Nowhere to send',
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/notifications')
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })

  test('the preferences section has no detectable violations', async ({
    page,
  }) => {
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/account')
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
