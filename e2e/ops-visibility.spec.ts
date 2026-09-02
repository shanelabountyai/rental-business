import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// R-147: the operational-visibility panels (R-145's "readers with no
// screen"). Reconciliation drift and the Stripe event log on /money, the
// dead-letter queue on /notifications - all portfolio plumbing that carries
// no propertyId, so each panel renders only for an actor whose grant covers
// everything and is absent for a property-scoped manager.
//
// Rows are seeded directly rather than by driving a webhook or the outbox,
// because these tests are about the SCREENS - the writers have their own
// unit suites. Every assertion targets a string unique to this run, never a
// count, because all three readers are deliberately global.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const stripeEventIds: string[] = []
const outboxEventIds: string[] = []

async function createStaff(roleKey: string, scope?: { propertyId?: string }) {
  const email = `ops-visibility-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Ops Visibility Test',
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
    },
  })
  return staff
}

async function seedProperty() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Ops LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Ops House-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Ops St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
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
  // The drift audit rows cannot be cleaned up - AuditLog is append-only at
  // the database - and that is fine: they carry a run-unique detail no other
  // run will ever assert on, and recentDrift reads newest-first.
  await prisma.processedStripeEvent.deleteMany({
    where: { stripeEventId: { in: stripeEventIds } },
  })
  await prisma.outboxEvent.deleteMany({ where: { id: { in: outboxEventIds } } })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
  // Signing in writes AuditLog rows carrying actorStaffId, and that FK's
  // SetNull is an UPDATE the append-only trigger refuses - so a staff user
  // the trail mentions is deactivated, never deleted (the notifications
  // spec's own pattern).
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
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds } } })
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('the money screen ops panels', () => {
  test('a portfolio owner sees drift and the Stripe event log', async ({ page }) => {
    const driftDetail = `e2e drift ${randomUUID()}`
    await prisma.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        actorRef: 'ledger.reconcile',
        entityType: 'LedgerEntry',
        entityId: 'reconciliation',
        action: 'ledger.drift_detected',
        after: {
          windowDays: 30,
          checkedEvents: 12,
          checkedEntries: 11,
          externalChecked: false,
          drift: [
            {
              kind: 'missing_ledger_row',
              stripeEventId: `evt_${randomUUID().slice(0, 12)}`,
              ledgerEntryId: null,
              differenceCents: 12345,
              detail: driftDetail,
            },
          ],
        },
      },
    })

    const bigRunDetail = `e2e drift big ${randomUUID()}`
    await prisma.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        actorRef: 'ledger.reconcile',
        entityType: 'LedgerEntry',
        entityId: 'reconciliation',
        action: 'ledger.drift_detected',
        after: {
          windowDays: 30,
          checkedEvents: 40,
          checkedEntries: 28,
          externalChecked: false,
          drift: Array.from({ length: 12 }, (_, i) => ({
            kind: 'missing_ledger_row',
            stripeEventId: `evt_${randomUUID().slice(0, 12)}`,
            ledgerEntryId: null,
            differenceCents: 100 + i,
            detail: `${bigRunDetail} #${i}`,
          })),
        },
      },
    })

    const stripeDetail = `e2e stripe ${randomUUID()}`
    const stripeEventId = `evt_e2e_${randomUUID()}`
    stripeEventIds.push(stripeEventId)
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId,
        type: 'customer.discount.created',
        outcome: 'ignored',
        detail: stripeDetail,
        // Far future ON PURPOSE. The screen lists the newest 25 by
        // occurredAt, and the shared database carries over a thousand
        // FUTURE-dated rows left by unit-test fixtures (1,099 measured when
        // this spec was written) - a row stamped "now" can never surface.
        // Deleted by id in afterAll, so this cannot join that debris.
        occurredAt: new Date('9999-01-01T00:00:00Z'),
      },
    })

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/money')

    await expect(
      page.getByRole('heading', { name: 'Reconciliation drift' }),
    ).toBeVisible()
    // One combined assertion: the detail is unique to this attempt, so a
    // retry's second seeded run cannot make it ambiguous - "off by $123.45"
    // alone resolved to two elements the moment a retry happened. It also
    // proves the money math survived the Json round trip: 12345 cents.
    await expect(
      page.getByText(`${driftDetail} — off by $123.45`),
    ).toBeVisible()

    // The cap R-152's walk forced: a run with more than eight discrepancies
    // renders a sample and an honest remainder, not a 200,000px page.
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: bigRunDetail })
        .getByText('…and 4 more discrepancies in this run.'),
    ).toBeVisible()

    await expect(
      page.getByRole('heading', { name: 'Stripe event log' }),
    ).toBeVisible()
    await expect(page.getByText(stripeDetail)).toBeVisible()

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })

  test('a property-scoped manager sees neither panel', async ({ page }) => {
    const property = await seedProperty()
    const staff = await createStaff('manager', { propertyId: property.id })
    await signIn(page, staff.email)
    await page.goto('/money')

    // The page itself renders for them - ledger.read within their scope.
    await expect(page.getByRole('heading', { name: 'Money' })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Reconciliation drift' }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Stripe event log' }),
    ).toHaveCount(0)
  })
})

test.describe('the dead-letter panel', () => {
  test('a portfolio owner sees an event that exhausted its retries', async ({
    page,
  }) => {
    const lastError = `e2e dead letter ${randomUUID()}`
    const event = await prisma.outboxEvent.create({
      data: {
        type: 'ticket.opened',
        aggregateType: 'Ticket',
        aggregateId: `e2e-${randomUUID()}`,
        payload: {},
        // Old, so the oldest-first query cannot push this row off the end
        // even if crashed runs have left other dead letters behind.
        occurredAt: new Date('2000-01-01T00:00:00Z'),
        publishedAt: null,
        // MAX_ATTEMPTS in lib/jobs/outbox.ts. At the cap the dispatcher
        // ignores the row, so seeding it cannot feed a real consumer.
        attempts: 5,
        lastError,
      },
    })
    outboxEventIds.push(event.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto('/notifications')

    await expect(
      page.getByRole('heading', { name: 'Events that gave up' }),
    ).toBeVisible()
    await expect(page.getByText(lastError)).toBeVisible()
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: lastError })
        .getByText('Gave up after 5 attempts'),
    ).toBeVisible()
  })

  test('a property-scoped manager does not see the panel', async ({ page }) => {
    const property = await seedProperty()
    const staff = await createStaff('manager', { propertyId: property.id })
    await signIn(page, staff.email)
    await page.goto('/notifications')

    await expect(
      page.getByRole('heading', { name: 'Notifications' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Events that gave up' }),
    ).toHaveCount(0)
  })
})
