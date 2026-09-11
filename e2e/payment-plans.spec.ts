import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// Repayment plans (PAY-08, PAY-12; R-175).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES.
//
// The schedule arithmetic is unit-tested in packages/core/payments, and the
// nightly break is proved against a real database in
// lib/payments/payment-plan-job.test.ts. Neither can show the two things
// this item is actually for.
//
// FIRST: that agreeing a plan is the ONLY way the pause gets switched on.
// The whole defect was a `payment_plan` hold with a sentence typed into it,
// and the fix is only real if the hand-placed version is gone from the
// screen where somebody would reach for it.
//
// SECOND: that the plan's own result renders at all. Agreeing one replaces
// the form that produced it with the live-plan block, which is precisely the
// self-replacing-panel trap (R-044, R-086) — a `FormAlerts` inside that form
// would be destroyed by its own response and the press would appear to do
// nothing.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

/// `contact: false` seeds a tenant with no email and no phone - the one the
/// schedule cannot reach, which the staff notice has to say out loud.
async function seedTenancy({ contact = true }: { contact?: boolean } = {}) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Plan LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Plan House-${stamp}`,
      addressLine1: '6 Instalment Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Plan',
      lastName: `Tenant-${stamp}`,
      email: contact ? `plan-tenant-${stamp}@example.test` : null,
    },
  })
  tenantIds.push(tenant.id)
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
  return { property, lease, tenant }
}

/// An owner, portfolio-wide. `hold.manage` is what a plan runs on, and the
/// seeded owner role carries it without the second factor a protected lift
/// would need — this file is not testing the permission split, lease-holds
/// already does.
async function seedOwner() {
  const email = `plan-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Plan Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

// Login is rate-limited per IP (R-003) and every test here signs in; without
// a distinct forwarded-for the later ones throttle and read as a broken page.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.authToken.deleteMany({ where: { subjectId: { in: tenantIds } } })
  // Nothing is deleted: LeaseHold and PaymentPlan both point at StaffUser
  // with onDelete: Restrict, and every action here writes an append-only
  // audit row. The roots are retired instead, which is the pattern CLAUDE.md
  // names — and deactivating the property is also what marks these specs as
  // finished for the notification drain.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({
    where: { propertyId: { in: propertyIds } },
    data: { status: 'ENDED' },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('agreeing a plan writes a schedule, pauses the chase, and says so on the page', async ({
  page,
}) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // The heading by ROLE, never by its text: Next's own route announcer is a
  // second copy of the page's heading and matches `getByText` too.
  await expect(page.getByRole('heading', { name: 'Repayment plan' })).toBeVisible()
  await expect(page.getByText('No plan is in force on this tenancy.')).toBeVisible()

  await page.getByLabel('Amount the plan repays (dollars)').fill('900.00')
  await page.getByLabel('Number of instalments').fill('3')
  await page.getByLabel('First instalment due on').fill('2026-10-01')
  await page
    .getByLabel('What was agreed, in words (required)')
    .fill('Three payments; she starts the new job on the 14th.')
  await page.getByRole('button', { name: 'Agree this repayment plan' }).click()

  // THE PRESS'S OWN RESULT, rendered outside the form the press destroyed.
  // Assert the sentence with getByText, never getByRole('alert') — the route
  // announcer answers to that role on every page (R-138).
  await expect(page.getByText(/Plan agreed: 3 instalments/)).toBeVisible()

  // The schedule, split evenly and dated monthly from the first instalment.
  // BY ROLE AND EXACT, not by text: the same date appears in the notice above
  // and in "Next instalment 1 Oct 2026" beside it, so `getByText` resolves to
  // three elements and fails strict mode. Three matching elements is not a
  // flaky test — it is an ambiguity for anybody navigating by name, and the
  // fix is the more specific locator rather than a relaxed assertion.
  await expect(page.getByRole('cell', { name: '1 Oct 2026', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: '1 Dec 2026', exact: true })).toBeVisible()
  await expect(page.getByText('$900.00 still to pay')).toBeVisible()

  // And the pause is real: a hold now exists, and it points at the plan
  // rather than carrying a sentence nothing can check.
  const hold = await prisma.leaseHold.findFirstOrThrow({
    where: { leaseId: lease.id, type: 'PAYMENT_PLAN', liftedAt: null },
    select: { paymentPlanId: true },
  })
  expect(hold.paymentPlanId).not.toBeNull()

  // R-199: AND THE TENANT WAS SENT THE TERMS. The notice names who it went
  // to, and the Notification row holds the whole schedule as it was sent -
  // that row is what answers "we were never told" when the plan breaks.
  await expect(page.getByText(`The written schedule is on its way to Plan ${tenant.lastName}.`)).toBeVisible()
  const sent = await prisma.notification.findFirstOrThrow({
    where: {
      recipientType: 'TENANT',
      recipientId: tenant.id,
      templateKey: 'payment_plan.agreed',
      channel: 'EMAIL',
    },
    select: { body: true, toAddress: true },
  })
  expect(sent.toAddress).toBe(tenant.email)
  expect(sent.body).toContain('1. 1 Oct 2026 — $300.00')
  expect(sent.body).toContain('3. 1 Dec 2026 — $300.00')
})

test('the tenant sees the plan they are keeping on their portal', async ({ page }) => {
  const { property, lease, tenant } = await seedTenancy()
  const staff = await seedOwner()
  await prisma.paymentPlan.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      arrearsCents: 90_000,
      startedOn: new Date('2026-09-11'),
      note: 'Three payments from October.',
      createdByStaffId: staff.id,
      instalments: {
        create: [
          { sequence: 1, dueOn: new Date('2026-10-01'), amountCents: 30_000 },
          { sequence: 2, dueOn: new Date('2026-11-01'), amountCents: 30_000 },
          { sequence: 3, dueOn: new Date('2026-12-01'), amountCents: 30_000 },
        ],
      },
    },
  })

  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenant.id,
      expiresAt: minted.expiresAt,
    },
  })
  await page.goto(`/portal/verify?token=${minted.token}`)
  await expect(page).toHaveURL(/\/portal$/)

  const plan = page.getByRole('region', { name: 'Your repayment plan' })
  await expect(plan.getByRole('cell', { name: '1 Oct 2026', exact: true })).toBeVisible()
  await expect(plan.getByRole('cell', { name: '1 Dec 2026', exact: true })).toBeVisible()
  await expect(plan.getByText('Your regular rent is still due each month on top of these.', { exact: false })).toBeVisible()
  await expect(plan.getByText(/Still to pay: \$900\.00/)).toBeVisible()

  const results = await axeScan(page)
  expect(results.violations).toEqual([])
})

test('a payment-plan hold can no longer be placed by hand', async ({ page }) => {
  const { lease } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // THE WHOLE POINT OF THE ITEM, on the screen somebody would reach for it.
  // The type is gone from the list; `placeLeaseHold` refuses it too, because
  // a posted value is not a choice this list made — that half is covered by
  // the action's own guard rather than by forging a request here.
  const options = await page.getByLabel('Hold type').locator('option').allTextContents()
  expect(options).not.toContain('Payment plan in force')
  expect(options).toContain('Bankruptcy — automatic stay')
})

test('ending a plan by hand resumes the chase and keeps the record of it', async ({ page }) => {
  const { lease, tenant } = await seedTenancy({ contact: false })
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Amount the plan repays (dollars)').fill('600.00')
  await page.getByLabel('Number of instalments').fill('2')
  await page.getByLabel('First instalment due on').fill('2026-11-01')
  await page.getByLabel('What was agreed, in words (required)').fill('Two payments after the tax refund.')
  await page.getByRole('button', { name: 'Agree this repayment plan' }).click()
  await expect(page.getByText(/Plan agreed: 2 instalments/)).toBeVisible()
  // Nobody to send it to, and the person at the screen is told so (R-199).
  await expect(
    page.getByText(`Not sent to Plan ${tenant.lastName} — no email or phone we may use; give them a copy yourself.`, { exact: false }),
  ).toBeVisible()

  await page
    .getByLabel('Why this plan is ending (required)')
    .fill('Tenant moved out; deposit disposition covers the balance.')
  await page.getByRole('button', { name: 'End this repayment plan' }).click()

  await expect(page.getByText('Plan cancelled. The chase and the late-fee meter resume from now.')).toBeVisible()
  await expect(page.getByText('No plan is in force on this tenancy.')).toBeVisible()

  // The ended plan is still on the page — "we offered them a plan and it
  // ended in November" is the content of the next conversation about this
  // tenancy, and a screen showing only what is live cannot say it.
  await expect(page.getByText('1 earlier plan')).toBeVisible()

  // And the pause is genuinely off.
  const live = await prisma.leaseHold.count({
    where: { leaseId: lease.id, type: 'PAYMENT_PLAN', liftedAt: null },
  })
  expect(live).toBe(0)
})

test('accessibility with a plan in force (WCAG 2.1 AA)', async ({ page }) => {
  const { lease } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // Scanned with a LIVE plan, not with the empty panel. The state that adds
  // markup — a data table with its own caption, a status pill, a second
  // required-reason form on a page that already has three — is the state the
  // empty one cannot exercise.
  await page.getByLabel('Amount the plan repays (dollars)').fill('450.00')
  await page.getByLabel('Number of instalments').fill('3')
  await page.getByLabel('First instalment due on').fill('2026-10-15')
  await page.getByLabel('What was agreed, in words (required)').fill('Three payments from October.')
  await page.getByRole('button', { name: 'Agree this repayment plan' }).click()
  await expect(page.getByText(/Plan agreed: 3 instalments/)).toBeVisible()

  const results = await axeScan(page)
  expect(results.violations).toEqual([])
})

test('the fair-housing report names the tenancies nobody offered a plan', async ({ page }) => {
  // The same argument D-34 makes for waivers, about the decision that
  // actually avoids a filing: a report of plans alone shows only leniency
  // and hides its distribution.
  const { property, lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  // A served notice is what puts this tenancy in the denominator — somebody
  // had already decided it was in arrears.
  await prisma.notice.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'notice_to_pay_or_quit',
      addressOfRecord: '6 Instalment Way, Houston TX',
      servedAt: new Date(),
      serviceMethod: 'PERSONAL',
    },
  })

  await signIn(page, staff.email)
  await page.goto('/money')

  const row = page
    .getByRole('region', { name: 'Repayment plans by tenant' })
    .getByRole('row', { name: new RegExp(tenant.lastName) })
  await expect(row).toBeVisible()
  await expect(row).toContainText('never offered a plan')
})
