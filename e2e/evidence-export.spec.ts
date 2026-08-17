import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// The court/adjuster packet through the UI (COMM-05, PAY-09, R-052): the
// thread transcript and the statement of account.
//
// WHAT THIS FILE IS FOR, given the documents themselves are already covered.
// The CONTENT of both PDFs is unit-tested exhaustively in core
// (packages/core/comms/record.test.ts, ledger/statement-document.test.ts),
// where a wrong figure or an overstated delivery status is asserted directly
// against the block list. Re-asserting that here through a rendered PDF would
// be slower and weaker. What only an end-to-end run can establish is the
// WIRING: that the action is reachable from the page, that the archived
// Document actually exists and downloads as a PDF, that the audit row is
// written, and that a staff member outside the property's scope cannot reach
// any of it.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const staff = await prisma.staffUser.create({
    data: {
      email: `evidence-${randomUUID()}@example.test`,
      name: 'Evidence Test',
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
  return staff
}

async function seedTenancy() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Evidence LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Evidence House-${randomUUID().slice(0, 8)}`,
      addressLine1: '9 Evidence Way',
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
      firstName: 'Robin',
      lastName: `E-${randomUUID().slice(0, 6)}`,
      // Never a literal - a crashed run left an active tenant holding a
      // hardcoded number once, and SMS routing then correctly refused to
      // guess between two candidates for an unknown number of runs.
      phone: uniquePhone(),
      email: `robin-${randomUUID().slice(0, 8)}@example.test`,
    },
  })
  tenantIds.push(tenant.id)

  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
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
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  const thread = await prisma.thread.create({
    data: {
      key: `tenant:${tenant.id}:property:${property.id}`,
      propertyId: property.id,
      tenantId: tenant.id,
    },
  })
  return { entity, property, tenant, unit, lease, thread }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/)
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Message, Notification, AuditLog and LedgerEntry are all append-only by
  // trigger, so nothing this file touched can be deleted - the properties and
  // tenants are deactivated instead, which is what every other spec here does
  // and for the same reason.
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
})

test('a thread transcript archives a PDF that includes the notifications, not just the messages', async ({
  page,
}) => {
  const { property, tenant, thread } = await seedTenancy()
  const staff = await createStaff('owner')

  await prisma.message.create({
    data: {
      threadId: thread.id,
      channel: 'SMS',
      direction: 'INBOUND',
      body: 'The heater has been out for two days.',
      sentAt: new Date('2026-03-02T15:00:00Z'),
      tenantId: tenant.id,
    },
  })

  // THE ROW THE OLD TRANSCRIPT WOULD HAVE MISSED. A rent reminder is a
  // Notification, not a Message, so a transcript built from the thread alone
  // omits it - and a packet showing the tenant's complaints but none of our
  // eleven reminders argues their case, not ours.
  const notification = await prisma.notification.create({
    data: {
      idempotencyKey: `evidence-${randomUUID()}`,
      category: 'rent_reminder',
      channel: 'EMAIL',
      recipientType: 'TENANT',
      recipientId: tenant.id,
      toAddress: tenant.email!,
      templateKey: 'rent.reminder',
      subject: 'Rent is due Friday',
      body: 'Your rent of $1,500.00 is due on Friday.',
      propertyId: property.id,
    },
  })
  await prisma.notificationDelivery.create({
    data: {
      notificationId: notification.id,
      status: 'DELIVERED',
      sentAt: new Date('2026-03-01T14:00:00Z'),
      deliveredAt: new Date('2026-03-01T14:00:05Z'),
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/messages/${thread.id}`)

  await page.getByText('Export this conversation').click()
  await page.getByRole('button', { name: 'Produce transcript' }).click()

  // Two entries: the tenant's text AND the notification.
  await expect(page.getByText(/Transcript produced: 2 entries/)).toBeVisible()

  const document = await prisma.document.findFirstOrThrow({
    where: { propertyId: property.id, type: 'COMMS_TRANSCRIPT' },
    orderBy: { createdAt: 'desc' },
  })
  expect(document.contentType).toBe('application/pdf')
  expect(document.sizeBytes).toBeGreaterThan(0)
  // NOT linked to the tenant: a packet assembled for a dispute with them must
  // not appear in their own portal papers list.
  expect(document.tenantId).toBeNull()

  // The export is the privileged act, and the trail says who took it.
  const entry = await prisma.auditLog.findFirstOrThrow({
    where: { entityType: 'Thread', entityId: thread.id, action: 'comms.transcript_exported' },
  })
  expect(entry.actorStaffId).toBe(staff.id)
  expect((entry.after as { entryCount?: number }).entryCount).toBe(2)

  // And it actually downloads as a PDF rather than being a row pointing at
  // nothing - the failure an orphaned storage write would produce.
  const response = await page.request.get(`/api/documents/${document.id}/file`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('pdf')
})

test('a statement of account carries the earlier balance into the period', async ({
  page,
}) => {
  const { property, lease } = await seedTenancy()
  const staff = await createStaff('owner')

  // February leaves $500 owed; March is fully paid. A statement for March
  // that opened at zero would close at zero and be materially false while
  // every line on it stayed arithmetically correct.
  await prisma.ledgerEntry.createMany({
    data: [
      {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'CHARGE',
        amountCents: 150_000,
        description: 'Rent — February',
        occurredAt: new Date('2026-02-01T12:00:00Z'),
      },
      {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'PAYMENT',
        amountCents: -100_000,
        description: 'Payment',
        occurredAt: new Date('2026-02-05T12:00:00Z'),
      },
      {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'CHARGE',
        amountCents: 150_000,
        description: 'Rent — March',
        occurredAt: new Date('2026-03-01T12:00:00Z'),
      },
      {
        propertyId: property.id,
        leaseId: lease.id,
        type: 'PAYMENT',
        amountCents: -150_000,
        description: 'Payment',
        occurredAt: new Date('2026-03-03T12:00:00Z'),
      },
    ],
  })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // "Statement from"/"Statement to", not "From"/"To" - the lease page also
  // carries a recurring-charge panel with a "Billing from" date, and the bare
  // labels collided with it. Fixed in the component rather than worked around
  // with a scoped locator here, because the ambiguity was real for a screen
  // reader too, not just for this selector.
  await page.getByLabel('Statement from').fill('2026-03-01')
  await page.getByLabel('Statement to').fill('2026-03-31')
  await page.getByRole('button', { name: 'Produce statement' }).click()

  await expect(page.getByText('Statement produced.')).toBeVisible()

  const entry = await prisma.auditLog.findFirstOrThrow({
    where: { entityType: 'Lease', entityId: lease.id, action: 'ledger.statement_exported' },
  })
  const after = entry.after as {
    closingBalanceCents?: number
    lineCount?: number
    periodFrom?: string
  }
  // $500 carried in from February, not zero.
  expect(after.closingBalanceCents).toBe(50_000)
  expect(after.lineCount).toBe(2)
  expect(after.periodFrom).toBe('2026-03-01')

  const document = await prisma.document.findFirstOrThrow({
    where: { leaseId: lease.id, type: 'LEDGER_STATEMENT' },
    orderBy: { createdAt: 'desc' },
  })
  const response = await page.request.get(`/api/documents/${document.id}/file`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('pdf')
})

test('a thread outside the actor’s scope answers 404, not 403', async ({ page }) => {
  // ROLE-01, deliberately: "forbidden" would confirm that a conversation with
  // that id exists at a property this actor was told nothing about.
  const theirs = await seedTenancy()
  const mine = await seedTenancy()
  const staff = await createStaff('manager', { propertyId: mine.property.id })

  await signIn(page, staff.email)
  const response = await page.request.get(`/messages/${theirs.thread.id}`)
  expect(response.status()).toBe(404)
})
