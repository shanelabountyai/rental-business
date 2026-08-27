import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { Secret, TOTP } from 'otpauth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, expectFocusSurvived, uniquePhone } from './fixtures.ts'

// Waiving a fee, and seeing who has been forgiven (PAY-04, D-34, R-041).
//
// This screen exists because the product started charging automatically
// before it could stop: the nightly job assesses late fees from jurisdiction
// config, and until R-041 `waiveCharge()` was written, tested, and callable
// by nothing. The assertion that matters most is that the waiver is a CREDIT
// with a reason and a named approver on the record - not a deletion.

// The same passphrase every other spec uses. A short one trips the policy
// and the failure surfaces as a sign-in timeout, which reads like a broken
// page rather than a rejected password.
const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const staffIds: string[] = []

async function seed(options: { portfolioWide?: boolean } = {}) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Waive LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Waive House-${stamp}`,
      addressLine1: '7 Waiver Way',
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
    data: { firstName: 'Ash', lastName: `Waive-${stamp}`, phone: uniquePhone() },
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

  const fee = await prisma.charge.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'LATE_FEE',
      amountCents: 5_000,
      description: 'Late fee — 5 days past due (flat $50)',
      dueOn: new Date('2026-03-06'),
    },
  })

  // MFA ENROLLED, because `fee.waive` is a privileged permission and R-004
  // requires a verified second factor for it. Forgiving money is exactly the
  // class of action that control exists for, and a fixture without MFA
  // renders no waive control at all - which is the product working, not a
  // bug, and cost a debugging pass to establish.
  const email = `waive-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Waiver Manager',
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
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    // Property-scoped by default, which is the realistic case and the one the
    // waive control should work under. The /money report needs a
    // PORTFOLIO-WIDE grant because it opens with an unscoped
    // `requirePermission('ledger.read')` - the same rule verify-close.spec
    // documents for the work order page, and a distinction worth exercising
    // rather than papering over.
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      ...(options.portfolioWide ? {} : { propertyId: property.id }),
    },
  })

  return { lease, fee, staff: { ...staff, secret }, tenant }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // The second factor, every time. `fee.waive` is privileged and the session
  // must carry a verified MFA to hold it.
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

// Login is rate-limited per IP (R-003), and every test in this file signs in.
// Without a distinct address per test the later ones are throttled, and the
// failure surfaces as a sign-in that never navigates - which reads like a
// broken page rather than a working control. The same guard every other
// sign-in-heavy spec carries.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  // Deactivated, never deleted: Charge rows are referenced by append-only
  // ledger entries and audit rows, whose foreign keys are RESTRICT.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('waiving a fee', () => {
  test('REFUSES to waive without a reason', async ({ page }) => {
    // Not bureaucracy: "why" is the first question in a fair-housing review,
    // and a hundred waivers with an empty reason column are indistinguishable
    // from an arbitrary pattern.
    const { lease, fee, staff } = await seed()
    await signIn(page, staff)
    await page.goto(`/leases/${lease.id}`)

    await page.getByText(/^Waive this late fee of /).click()

    // THE BROWSER REFUSES FIRST SINCE R-116. The reason field was `required`
    // on the server and marked required nowhere - the only hint was a
    // placeholder, which disappears on focus, so the way to find out was to
    // be refused. It is a `TextField` now, which marks it.
    await page.getByRole('button', { name: /^Waive \$/ }).click()
    await expect(page.getByLabel('Why is this being waived?')).toBeFocused()

    // AND THE SERVER IS STILL THE GATE. `required` is a convenience - it
    // stops the refusal from costing whoever hits it what they had typed -
    // so the check that actually protects the fair-housing record is proved
    // by taking the attribute off and submitting anyway.
    await page
      .getByLabel('Why is this being waived?')
      .evaluate((el) => el.removeAttribute('required'))
    await page.getByRole('button', { name: /^Waive \$/ }).click()

    await expect(page.getByText('Say why this is being waived')).toBeVisible()
    const untouched = await prisma.charge.findUniqueOrThrow({ where: { id: fee.id } })
    expect(untouched.waivedAt).toBeNull()
  })

  test('waives as a CREDIT with the reason and the approver on the record', async ({ page }) => {
    const { lease, fee, staff } = await seed()
    await signIn(page, staff)
    await page.goto(`/leases/${lease.id}`)

    await expect(page.getByRole('heading', { name: 'Fees' })).toBeVisible()

    // `getByText`, not a role: since R-099 the trigger is a native
    // `<summary>`, which has no portable role mapping - the app's other
    // disclosures are selected the same way. The NAME is the point of the
    // change: every fee on the lease rendered the identical string "Waive
    // this fee", so a screen-reader user listing the page's controls heard it
    // N times with nothing to tell them apart.
    await page.getByText(/^Waive this late fee of /).click()

    // THE ASSERTION THAT WAS MISSING FROM THE WHOLE GATE. The `useState`
    // toggle this replaced had the trigger unmount itself on activation, so
    // focus fell to `<body>` - invisible to axe, which scans a static
    // snapshot and cannot see where focus went.
    await expectFocusSurvived(page, 'opening the waive-a-fee disclosure')

    await page.getByLabel('Why is this being waived?').fill('First late payment in two years')
    await page.getByRole('button', { name: /^Waive \$/ }).click()

    await expect
      .poll(
        async () => (await prisma.charge.findUnique({ where: { id: fee.id } }))?.waivedAt != null,
        { timeout: 15_000 },
      )
      .toBe(true)

    const waived = await prisma.charge.findUniqueOrThrow({ where: { id: fee.id } })
    // NOT deleted. The fee and the decision to forgive it both stay.
    expect(waived.amountCents).toBe(5_000)
    expect(waived.waiveReason).toBe('First late payment in two years')
    expect(waived.waivedByStaffId).toBe(staff.id)

    // And the trail carries the reason, on a privileged action.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'fee.waived', entityId: fee.id },
    })
    expect(entry.reason).toBe('First late payment in two years')

    // The screen now shows the waiver rather than offering it again.
    await page.reload()
    await expect(page.getByText('First late payment in two years')).toBeVisible()
    await expect(page.getByText(/^Waive this late fee of /)).toHaveCount(0)
  })

  test('REFUSES a fee above the waiver ceiling, and says by how much', async ({ page }) => {
    // R-004 built `waive_fee` as a monetary action with a per-role ceiling
    // and nothing had ever called it. A manager's is $100 - so without this
    // they could forgive a fee larger than the work order the same role
    // cannot approve.
    const { lease, fee, staff } = await seed()
    await prisma.charge.update({ where: { id: fee.id }, data: { amountCents: 50_000 } })

    await signIn(page, staff)
    await page.goto(`/leases/${lease.id}`)
    await page.getByText(/^Waive this late fee of /).click()
    await page.getByLabel('Why is this being waived?').fill('Trying it on')
    await page.getByRole('button', { name: /^Waive \$/ }).click()

    await expect(page.getByText('you can waive up to')).toBeVisible()
    const untouched = await prisma.charge.findUniqueOrThrow({ where: { id: fee.id } })
    expect(untouched.waivedAt).toBeNull()
  })

  test('the fair-housing report names tenants with NO waivers too', async ({ page }) => {
    // D-34: a report of waivers alone shows only generosity and hides its
    // distribution. The tenants who were never forgiven anything are half
    // the pattern, and the half an operator is least likely to think about.
    const { staff, tenant } = await seed({ portfolioWide: true })
    await signIn(page, staff)
    await page.goto('/money')

    await expect(page.getByRole('heading', { name: 'Fee waivers by tenant' })).toBeVisible()
    const row = page.getByRole('row', { name: new RegExp(tenant.lastName) })
    await expect(row).toBeVisible()
    await expect(row).toContainText('0%')
  })

  test('accessibility (§6.4, WCAG 2.1 AA)', async ({ page }) => {
    const { lease, staff } = await seed()
    await signIn(page, staff)
    await page.goto(`/leases/${lease.id}`)
    await page.getByText(/^Waive this late fee of /).click()
    await expect(page.getByLabel('Why is this being waived?')).toBeVisible()

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
