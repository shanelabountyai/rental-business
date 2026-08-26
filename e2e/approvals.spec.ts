import { randomUUID } from 'node:crypto'
import { Secret, TOTP } from 'otpauth'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniquePhone } from './fixtures.ts'

// Approval thresholds end to end (MAINT-04, ROLE-02, R-026).
//
// The financial control this whole item exists to enforce: a manager with a
// $300 ceiling must not be able to commit $5,000, and money already spent
// past what was approved has to go back before it can close. Both are
// asserted here against real staff ceilings and a real entity threshold,
// because an approval flow that only works in unit tests is a flow that
// approves nothing in production.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []
const workOrderIds: string[] = []
const vendorIds: string[] = []

/**
 * `approveWorkOrderCents` is the PERSONAL override on StaffUser (ROLE-02) -
 * null falls back to the role default, which for `owner` is
 * null-means-unlimited and for `manager` is $500.
 *
 * ENROLLED IN MFA, always. `workorder.approve` is in PRIVILEGED_PERMISSIONS,
 * and ROLE-05 requires a second factor before any privileged action - so a
 * password-only session genuinely cannot approve a spend, and a test that
 * signed in with a password alone would be testing a state no approver is
 * ever in. R-026 found this the hard way: the panel rendered "waiting on
 * somebody with approval authority" to an owner who had all the authority
 * there is and simply had not done MFA.
 */
async function createStaff(
  roleKey: string,
  options: { approveWorkOrderCents?: number | null } = {},
) {
  const unique = randomUUID().slice(0, 8)
  const { secret } = createTotpEnrolment(`appr-${unique}@example.test`)
  const staff = await prisma.staffUser.create({
    data: {
      email: `appr-${unique}@example.test`,
      name: `Approval Test ${unique}`,
      approveWorkOrderCents: options.approveWorkOrderCents,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, secret }
}

async function seedWorkOrder(options: {
  estimateCents?: number | null
  thresholdCents?: number | null
  tolerancePercent?: number | null
  status?: string
  approvedAmountCents?: number | null
}) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: {
      name: `Appr LLC-${unique}`,
      type: 'LLC',
      approvalThresholdCents: options.thresholdCents ?? 50_000,
      actualsTolerancePercent: options.tolerancePercent ?? 10,
    },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Appr House-${unique}`,
      addressLine1: '2 Ceiling Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      scope: 'Replace the water heater.',
      priority: 'URGENT',
      estimateCents: options.estimateCents ?? null,
      status: (options.status ?? 'SUBMITTED') as never,
      approvedAmountCents: options.approvedAmountCents ?? null,
    },
  })
  workOrderIds.push(workOrder.id)
  return { entity, property, unit, workOrder }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // The second factor, every time - see createStaff's own comment.
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.workOrderBid.deleteMany({ where: { workOrderId: { in: workOrderIds } } })
  await prisma.authToken.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
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

test.describe('routing by ceiling and threshold', () => {
  test('under the threshold needs nobody', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({
      estimateCents: 20_000,
      thresholdCents: 50_000,
    })
    const staff = await createStaff('manager', { approveWorkOrderCents: 30_000 })
    await signIn(page, staff)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: /send for approval/i }).click()
    await expect(page.getByText(/Under the approval threshold/)).toBeVisible()

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.status).toBe('SUBMITTED')
  })

  test('over the threshold but within the ceiling self-approves', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({
      estimateCents: 60_000,
      thresholdCents: 50_000,
    })
    const staff = await createStaff('manager', { approveWorkOrderCents: 100_000 })
    await signIn(page, staff)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: /send for approval/i }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('APPROVED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.approvedByStaffId).toBe(staff.id)
    // What was approved is recorded, not just that it was - the tolerance
    // check later measures against this number.
    expect(updated.approvedAmountCents).toBe(60_000)
  })

  test("ROUTES UP over the requester's ceiling, and raises it in the one queue", async ({
    page,
  }) => {
    // MAINT-04's own example, inverted: a $300 ceiling against a $650 spend.
    const { workOrder } = await seedWorkOrder({
      estimateCents: 65_000,
      thresholdCents: 50_000,
    })
    const staff = await createStaff('manager', { approveWorkOrderCents: 30_000 })
    await signIn(page, staff)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: /send for approval/i }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('PENDING_APPROVAL')

    // It is WORK, so it lands in the one queue (D-9), not an email.
    const task = await prisma.task.findFirstOrThrow({
      where: { type: 'workorder_approval', subjectId: workOrder.id },
    })
    expect(task.status).toBe('OPEN')

    // The trail records WHY it went up, including the ceiling at that moment.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.approval_requested', entityId: workOrder.id },
    })
    expect((entry.after as { requesterCeilingCents?: number }).requesterCeilingCents).toBe(30_000)
  })
})

test.describe('the approval decision', () => {
  test('an owner approves from the queue in two taps', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({
      estimateCents: 65_000,
      status: 'PENDING_APPROVAL',
    })
    const owner = await createStaff('owner')
    await signIn(page, owner)

    await page.goto(`/workorders/${workOrder.id}`)
    // Estimate and scope are on screen BEFORE the button - somebody
    // approving from a phone should have seen the number. `.first()` because
    // the amount legitimately appears twice: once in the work order's own
    // summary and once inside the approval panel, which is the point.
    await expect(page.getByText('$650.00').first()).toBeVisible()
    await page.getByRole('button', { name: 'Approve', exact: true }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('APPROVED')

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.approved', entityId: workOrder.id },
    })
    expect(entry.actorType).toBe('STAFF')
  })

  test('REFUSES an approver whose own ceiling does not cover it', async ({ page }) => {
    // The control that makes the ceiling real rather than decorative:
    // opening the queue item must not be enough to clear it.
    const { workOrder } = await seedWorkOrder({
      estimateCents: 500_000,
      status: 'PENDING_APPROVAL',
    })
    const manager = await createStaff('manager', { approveWorkOrderCents: 30_000 })
    await signIn(page, manager)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: 'Approve', exact: true }).click()

    await expect(page.getByText(/over your own approval ceiling/i)).toBeVisible()
    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.status).toBe('PENDING_APPROVAL')
    expect(updated.approvedAt).toBeNull()
  })

  test('denies with a reason, which cancels the work order', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({
      estimateCents: 65_000,
      status: 'PENDING_APPROVAL',
    })
    const owner = await createStaff('owner')
    await signIn(page, owner)

    await page.goto(`/workorders/${workOrder.id}`)
    // The disclosure and the submit inside it are two controls on one page,
    // so they carry two names (R-115). `<details>`/`<summary>` replaced the
    // `useState` toggle that used to unmount the button holding focus - and
    // a `<summary>` is reached with `getByText`, not `getByRole('button')`,
    // because it has no portable role mapping (the convention
    // `fee-waiver.spec.ts` already documents).
    await page.getByText('Deny, and say why').click()
    await page.getByLabel('Why not?').fill('Get a second quote first')
    await page.getByRole('button', { name: 'Send this denial' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('CANCELED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.denialReason).toBe('Get a second quote first')

    // workorder.denied is in REASON_REQUIRED, so the writer itself refuses an
    // entry without one - this asserts the reason actually landed.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.denied', entityId: workOrder.id },
    })
    expect(entry.reason).toBe('Get a second quote first')
  })

  test('asking a question leaves it pending - a question is not an answer', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({
      estimateCents: 65_000,
      status: 'PENDING_APPROVAL',
    })
    const owner = await createStaff('owner')
    await signIn(page, owner)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByText('Ask a question').click()
    await page.getByLabel('What do you want to know?').fill('Is it under warranty?')
    await page.getByRole('button', { name: 'Send question' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.approvalQuestion,
        { timeout: 10_000 },
      )
      .toBe('Is it under warranty?')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.status).toBe('PENDING_APPROVAL')
  })
})

test.describe('actuals over the approved amount', () => {
  test('sends it back for re-approval past the tolerance', async ({ page }) => {
    // $500 approved, 10% tolerance, $700 spent.
    const { workOrder } = await seedWorkOrder({
      estimateCents: 50_000,
      status: 'APPROVED',
      approvedAmountCents: 50_000,
      tolerancePercent: 10,
    })
    const staff = await createStaff('manager', { approveWorkOrderCents: 100_000 })
    await signIn(page, staff)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel('Labour').fill('500')
    await page.getByLabel('Materials').fill('200')
    await page.getByRole('button', { name: 'Record actuals' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('PENDING_APPROVAL')

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.approval_requested', entityId: workOrder.id },
    })
    expect((entry.after as { reason?: string }).reason).toBe('actuals_over_tolerance')
  })

  test('stays approved within the tolerance', async ({ page }) => {
    // $500 approved, 10% tolerance, $540 spent - under the $550 line.
    const { workOrder } = await seedWorkOrder({
      estimateCents: 50_000,
      status: 'APPROVED',
      approvedAmountCents: 50_000,
      tolerancePercent: 10,
    })
    const staff = await createStaff('manager', { approveWorkOrderCents: 100_000 })
    await signIn(page, staff)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel('Labour').fill('400')
    await page.getByLabel('Materials').fill('140')
    await page.getByRole('button', { name: 'Record actuals' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))
            ?.actualLaborCents,
        { timeout: 10_000 },
      )
      .toBe(40_000)

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.status).toBe('APPROVED')
  })
})

test.describe('accessibility', () => {
  test('the approval panel has no detectable violations', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({
      estimateCents: 65_000,
      status: 'PENDING_APPROVAL',
    })
    const owner = await createStaff('owner')
    await signIn(page, owner)
    await page.goto(`/workorders/${workOrder.id}`)

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})

test.describe('bid collection (MAINT-04)', () => {
  test('asks several vendors, and one of them prices it through a zero-login link', async ({
    page,
  }) => {
    // Over the bid threshold, so the panel offers to collect competing
    // prices rather than just signing off the first number that came in.
    const { workOrder } = await seedWorkOrder({ estimateCents: 400_000 })
    const unique = randomUUID().slice(0, 6)
    const cheap = await prisma.vendor.create({
      data: { name: `Cheap-${unique}`, trades: ['plumbing'], phone: uniquePhone() },
    })
    const dear = await prisma.vendor.create({
      data: { name: `Dear-${unique}`, trades: ['plumbing'], phone: uniquePhone() },
    })
    vendorIds.push(cheap.id, dear.id)

    const staff = await createStaff('owner')
    await signIn(page, staff)
    await page.goto(`/workorders/${workOrder.id}`)

    await page.getByLabel(new RegExp(`Cheap-${unique}`)).check()
    await page.getByLabel(new RegExp(`Dear-${unique}`)).check()
    await page.getByRole('button', { name: 'Request bids' }).click()

    // A row exists per vendor from the moment they are ASKED, so "who never
    // answered" is answerable - half of what a comparison is for.
    await expect
      .poll(() => prisma.workOrderBid.count({ where: { workOrderId: workOrder.id } }), {
        timeout: 15_000,
      })
      .toBe(2)

    // Poll for the NOTIFICATION separately: requestBids() writes the bid row
    // BEFORE calling notify(), so the count above can be satisfied while the
    // message the token is read from does not exist yet. Exactly the race
    // R-025's own dispatch helper hit, for the same reason.
    await expect
      .poll(
        () =>
          prisma.notification.count({
            where: { propertyId: workOrder.propertyId, body: { contains: '/vendor/bid/' } },
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)

    const notification = await prisma.notification.findFirstOrThrow({
      where: { propertyId: workOrder.propertyId, body: { contains: '/vendor/bid/' } },
      orderBy: { createdAt: 'desc' },
    })
    const token = /\/vendor\/bid\/([A-Za-z0-9_-]+)/.exec(notification.body)![1]!

    // A brand new context: the vendor has no session and no account.
    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/bid/${token}`)
    // Says plainly that this is NOT an award - a vendor who turns up to a job
    // that was never theirs does not answer the next request.
    await expect(vendorPage.getByText(/not yet awarded/i)).toBeVisible()

    await vendorPage.getByLabel('Your price').fill('3200')
    await vendorPage.getByRole('button', { name: 'Send my price' }).click()

    await expect
      .poll(
        async () =>
          (
            await prisma.workOrderBid.findFirst({
              where: { workOrderId: workOrder.id, respondedAt: { not: null } },
            })
          )?.amountCents,
        { timeout: 15_000 },
      )
      .toBe(320_000)

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.bid_submitted', propertyId: workOrder.propertyId },
    })
    expect(entry.actorType).toBe('VENDOR')

    // And the PM sees it in the one comparison view, with the vendor who
    // never answered still on the list.
    await page.goto(`/workorders/${workOrder.id}`)
    await expect(page.getByText('$3,200.00')).toBeVisible()
    await expect(page.getByText('No answer yet')).toBeVisible()

    await vendorContext.close()
  })

  test('a bid link dies once the job has been assigned to somebody', async ({ page }) => {
    const { workOrder } = await seedWorkOrder({ estimateCents: 400_000 })
    const unique = randomUUID().slice(0, 6)
    const vendor = await prisma.vendor.create({
      // With contact details: a vendor with neither a phone nor an email has
      // no addressable channel, so R-016 records the notification as
      // suppressed and there is no message to read a token out of. That is
      // correct behaviour, and not what this test is about.
      data: { name: `Late-${unique}`, trades: ['plumbing'], phone: uniquePhone() },
    })
    vendorIds.push(vendor.id)

    const staff = await createStaff('owner')
    await signIn(page, staff)
    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel(new RegExp(`Late-${unique}`)).check()
    await page.getByRole('button', { name: 'Request bids' }).click()

    // The notification, not the bid row - see the sibling test's own comment
    // for why the bid row lands first and would race this.
    await expect
      .poll(
        () =>
          prisma.notification.count({
            where: { propertyId: workOrder.propertyId, body: { contains: '/vendor/bid/' } },
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)

    const notification = await prisma.notification.findFirstOrThrow({
      where: { propertyId: workOrder.propertyId, body: { contains: '/vendor/bid/' } },
      orderBy: { createdAt: 'desc' },
    })
    const token = /\/vendor\/bid\/([A-Za-z0-9_-]+)/.exec(notification.body)![1]!

    // The job gets awarded to somebody else while this vendor was thinking.
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { status: 'ASSIGNED' },
    })

    const vendorContext = await page.context().browser()!.newContext()
    const vendorPage = await vendorContext.newPage()
    await vendorPage.goto(`/vendor/bid/${token}`)
    await expect(vendorPage.getByText(/already been assigned/i)).toBeVisible()
    await vendorContext.close()
  })
})
