import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, expectFocusSurvived, uniquePhone } from './fixtures.ts'

// Comms threading through the UI (COMM-01, R-017): the inbox, a thread
// transcript with staff attribution, replying, logging a call, and the
// unsorted-messages triage queue.
//
// Nothing here is behind a privileged permission - message.read and
// message.send are ordinary grants - so every test signs in plainly.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const unroutedIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `messages-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Messages Test',
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

async function seedTenantWithThread(
  propertyId: string,
  overrides: { phone?: string; email?: string; lastName?: string } = {},
) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Casey',
      lastName: overrides.lastName ?? `T-${randomUUID().slice(0, 6)}`,
      phone: overrides.phone ?? '+15125550100',
      email: overrides.email ?? 'casey@example.test',
    },
  })
  tenantIds.push(tenant.id)
  const unit = await prisma.unit.create({
    data: {
      propertyId,
      name: `U-${randomUUID().slice(0, 6)}`,
      status: 'OCCUPIED',
    },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id },
  })
  const thread = await prisma.thread.create({
    data: {
      key: `tenant:${tenant.id}:property:${propertyId}`,
      propertyId,
      tenantId: tenant.id,
    },
  })
  return { tenant, thread }
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Message is append-only, so threads carrying one cannot be deleted and
  // neither can their properties. Deactivate instead - the same wall AuditLog
  // already puts up, handled the same way in every other spec.
  // UnroutedMessage is NOT append-only - it has a lifecycle - so unlike
  // Message it can be cleaned up. It must be: the triage list is deliberately
  // unscoped (an unrouted message has no property to scope it BY), so anything
  // this file leaves behind shows up in the next run's assertions.
  await prisma.unroutedMessage.deleteMany({
    where: { id: { in: unroutedIds } },
  })
  await prisma.unroutedMessage.updateMany({
    where: { routedByStaffId: { in: staffIds } },
    data: { routedByStaffId: null },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  const referenced = new Set(
    (
      await prisma.message.findMany({
        where: { staffUserId: { in: staffIds } },
        select: { staffUserId: true },
      })
    ).map((row) => row.staffUserId!),
  )
  const audited = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  const keep = new Set([...referenced, ...audited])
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !keep.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !keep.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...keep] } },
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

test.describe('the inbox', () => {
  test('lists a conversation with its latest message', async ({ page }) => {
    const { property } = await seedProperty()
    const { thread } = await seedTenantWithThread(property.id, {
      lastName: 'Nakamura',
    })
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'The kitchen tap is dripping',
        sentAt: new Date(),
      },
    })
    await prisma.thread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date() },
    })

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/messages')

    const row = page.getByRole('listitem').filter({ hasText: 'Casey Nakamura' })
    await expect(row).toBeVisible()
    await expect(row.getByText('The kitchen tap is dripping')).toBeVisible()
  })

  test('never lists a conversation outside the actor’s scope', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const { thread } = await seedTenantWithThread(theirs.id, {
      lastName: 'Hidden',
    })
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'not for you',
        sentAt: new Date(),
      },
    })

    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)
    await page.goto('/messages')
    await expect(page.getByText('Casey Hidden')).toHaveCount(0)

    // And the thread itself is a 404, not a 403 - a thread the actor may not
    // see must be indistinguishable from one that does not exist, or the
    // response confirms the tenancy exists.
    const response = await page.goto(`/messages/${thread.id}`)
    expect(response?.status()).toBe(404)
  })
})

test.describe('a thread', () => {
  test('sends a reply and attributes it to the staff member', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const { thread } = await seedTenantWithThread(property.id)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/messages/${thread.id}`)
    await page.waitForTimeout(500)
    await page.getByLabel('Reply').fill('A tech will be out Tuesday morning.')
    await page.locator('#field-reply-channel').selectOption('SMS')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(
      page.getByText('A tech will be out Tuesday morning.'),
    ).toBeVisible()
    // COMM-01: "full history shows including which staff member sent what".
    await expect(page.getByText(`Text from ${staff.name}`)).toBeVisible()

    await expect
      .poll(
        async () =>
          (
            await prisma.message.findFirst({
              where: { threadId: thread.id, direction: 'OUTBOUND' },
              include: { delivery: true },
            })
          )?.delivery?.status,
        { timeout: 10_000 },
      )
      .toBe('SENT')
  })

  test('logs a phone call into the same history', async ({ page }) => {
    const { property } = await seedProperty()
    const { thread } = await seedTenantWithThread(property.id)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/messages/${thread.id}`)
    await page.getByText('Log a phone call').click()
    await expectFocusSurvived(page, 'opening “Log a phone call” — a messages disclosure')
    await page.waitForTimeout(500)
    await page
      .getByLabel('What was said')
      .fill('Tenant agreed to Tuesday 9am. Confirmed the dog will be crated.')
    await page.getByRole('button', { name: 'Log call' }).click()

    await expect(page.getByText(/Tenant agreed to Tuesday 9am/)).toBeVisible()
    await expect(page.getByText(`Phone call — logged by ${staff.name}`)).toBeVisible()

    const logged = await prisma.message.findFirst({
      where: { threadId: thread.id, channel: 'CALL_LOG' },
    })
    expect(logged).not.toBeNull()
  })

  test('offers no reply box to a role that cannot send', async ({ page }) => {
    const { property } = await seedProperty()
    const { thread } = await seedTenantWithThread(property.id)
    // read_only holds message.read but not message.send.
    const staff = await createStaff('read_only')
    await signIn(page, staff.email)

    await page.goto(`/messages/${thread.id}`)
    await expect(page.getByLabel('Reply')).toHaveCount(0)
    await expect(page.getByText('Log a phone call')).toHaveCount(0)
  })
})

test.describe('unsorted messages', () => {
  test('shows an unroutable text and files it into a thread', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const { tenant } = await seedTenantWithThread(property.id, {
      lastName: 'Okonkwo',
      phone: uniquePhone(),
    })
    // Unique per run: the triage list is global by design, so a fixed string
    // would collide with anything an earlier run left behind.
    const body = `Hi it is Casey from the new phone ${randomUUID().slice(0, 8)}`
    const unrouted = await prisma.unroutedMessage.create({
      data: {
        channel: 'SMS',
        // Unique, and that matters more than it looks: this literal used to
        // be the exact number workorders.spec.ts seeds its tenant with, so a
        // fixture whose whole premise is "nobody owns this number" was
        // sharing one with a live tenant in a concurrently-running spec.
        // Harmless only because the row is written pre-routed; the moment
        // anything re-routes it, a stranger's text lands in that tenant's
        // permanent record.
        fromAddress: uniquePhone(),
        body,
        reason: 'UNKNOWN_SENDER',
        receivedAt: new Date('2026-08-05T09:00:00Z'),
      },
    })
    unroutedIds.push(unrouted.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/messages')
    await expect(page.getByText(/could not place/)).toBeVisible()

    await page.goto('/messages/unrouted')
    await expect(page.getByText(body)).toBeVisible()
    await expect(
      page.getByText('No tenant or vendor has this number on file').first(),
    ).toBeVisible()

    // Scoped to THIS row. The triage list is unscoped by design, so other
    // rows - from another test, or a real unplaceable text - are legitimately
    // on the page, each with its own File it button.
    const row = page
      .getByRole('listitem')
      .filter({ hasText: body })
    await page.waitForTimeout(500)
    await row.locator(`#field-unrouted-${unrouted.id}-tenantId`).selectOption(tenant.id)
    await row.getByRole('button', { name: 'File it' }).click()

    // Lands in the tenant's thread, carrying its ORIGINAL receipt time so the
    // transcript reads in the order things actually happened.
    await expect(page.getByText(body)).toBeVisible()
    await expect
      .poll(
        async () =>
          (
            await prisma.unroutedMessage.findUniqueOrThrow({
              where: { id: unrouted.id },
            })
          ).routedAt,
        { timeout: 10_000 },
      )
      .not.toBeNull()

    const filed = await prisma.message.findFirst({ where: { body } })
    expect(filed?.sentAt.toISOString()).toBe('2026-08-05T09:00:00.000Z')
  })
})

test.describe('accessibility', () => {
  test('the inbox and a thread have no detectable violations', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const { thread } = await seedTenantWithThread(property.id)
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'Hello',
        sentAt: new Date(),
      },
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    for (const url of ['/messages', `/messages/${thread.id}`, '/messages/unrouted']) {
      await page.goto(url)
      const results = await axeScan(page)
      expect(results.violations, url).toEqual([])
    }
  })
})
