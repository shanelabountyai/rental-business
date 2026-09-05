import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { expect, test } from '@playwright/test'
import { prisma } from '@rental/db'
import { Secret, TOTP } from 'otpauth'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// In-app staff management (ROLE-02, ROLE-04, ROLE-06; R-138).
//
// `grantAssignment` and `revokeAssignment` have existed since R-004 with a
// comment saying R-007 would build the screen. It did not, so until this item
// an owner could not add a colleague, change what one could do, or cut off a
// leaver without shell access to the server - and ROLE-04's property-scoped
// manager, the most interesting thing the permission model does, could only be
// made by writing a StaffAssignment row by hand.
//
// Every mutation here is MFA-gated: `staff.manage` is on
// PRIVILEGED_PERMISSIONS, so a fixture without an enrolled second factor
// renders no controls at all. That is the product working.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []

async function createStaff(
  roleKey: string,
  options: { mfa?: boolean; scope?: { propertyId?: string } } = {},
) {
  const email = `staff-admin-${randomUUID()}@example.test`
  const enrolment = options.mfa ? createTotpEnrolment(email) : null
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `Test Person ${randomUUID().slice(0, 6)}`,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          ...(enrolment
            ? { mfaSecret: sealSecret(enrolment.secret), mfaEnrolledAt: new Date() }
            : {}),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, ...(options.scope ?? {}) },
  })
  return { ...staff, secret: enrolment?.secret ?? null }
}

async function seedProperty() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Staff LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Staff House-${randomUUID().slice(0, 8)}`,
      addressLine1: '2 Admin St',
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

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string | null },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  if (staff.secret) {
    await page.waitForURL(/\/login\/mfa/)
    await page
      .getByLabel(/code/i)
      .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
    await page.getByRole('button', { name: 'Verify' }).click()
  }
  await page.waitForURL('**/dashboard')
}

// Sign-in is rate-limited to ten attempts per IP per five minutes (R-003) and
// every test here signs in at least once. Without a distinct address per test
// the later ones are throttled, and it surfaces as a sign-in that never
// navigates rather than as a refusal.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // By ownership, and never a delete of a row an append-only table
  // references: every mutation here writes an AuditLog entry, and
  // `StaffAssignment` rows hang off both staff users involved.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffAssignment.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
})

test('an owner invites a colleague, and the setup link actually signs them in', async ({
  page,
}) => {
  const owner = await createStaff('owner', { mfa: true })
  await signIn(page, owner)

  await page.goto('/staff')
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Add staff member' }).click()

  const email = `invited-${randomUUID()}@example.test`
  await page.getByLabel('Full name').fill('Riley Chen')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Role').selectOption('manager')
  await page.getByRole('button', { name: /Create account and send setup link/ }).click()

  // The link is shown, not only delivered: `deliverAuthLink` drops every auth
  // link in production, so an invite that could only be emailed would be an
  // invite that cannot work on a deployment.
  const link = page.getByText(/\/reset-password\?token=/)
  await expect(link).toBeVisible()
  const url = (await link.textContent())!.trim()

  const invited = await prisma.staffUser.findUniqueOrThrow({
    where: { email },
    include: { assignments: { include: { role: true } } },
  })
  staffIds.push(invited.id)
  expect(invited.assignments).toHaveLength(1)
  expect(invited.assignments[0]!.role.key).toBe('manager')
  expect(invited.assignments[0]!.propertyId).toBeNull()

  // R-139's regression, and it belongs in the e2e suite specifically because
  // e2e runs a PRODUCTION BUILD - which is the only environment the old
  // `deliverAuthLink` silently dropped. This run used to print "[auth]
  // staff_password_reset not delivered" and write nothing at all.
  const sent = await prisma.notification.findFirst({
    where: { recipientType: 'STAFF', recipientId: invited.id, category: 'account_access' },
    select: { channel: true, toAddress: true, body: true },
  })
  expect(sent).not.toBeNull()
  expect(sent!.channel).toBe('EMAIL')
  expect(sent!.toAddress).toBe(email)
  expect(sent!.body).toContain('/reset-password?token=')

  // The whole point of the item: somebody who was never touched by a shell
  // script sets a password and gets in.
  const context = await page.context().browser()!.newContext()
  // A new context does NOT inherit page.setExtraHTTPHeaders, and this one
  // signs in too (R-003's per-IP bucket).
  await context.setExtraHTTPHeaders(uniqueClientHeaders())
  const fresh = await context.newPage()
  await fresh.goto(new URL(url).pathname + new URL(url).search)
  await fresh.getByLabel('New password', { exact: true }).fill(PASSWORD)
  await fresh.getByLabel(/Confirm/i).fill(PASSWORD)
  await fresh.getByRole('button', { name: 'Save new password' }).click()

  // `completePasswordReset` ends in redirect('/login?reset=1'), so waiting for
  // that is waiting for the write. Navigating straight to /login instead
  // cancelled the POST that was still in flight and the password was never
  // set - the sign-in below then failed with "those details did not match an
  // account", which reads like a broken invite rather than a racing test.
  await fresh.waitForURL(/\/login\?reset=1/)
  await fresh.getByLabel('Email').fill(email)
  await fresh.getByLabel('Password').fill(PASSWORD)
  await fresh.getByRole('button', { name: 'Sign in' }).click()
  await fresh.waitForURL('**/dashboard')
  await context.close()
})

test('ROLE-04: an owner grants a property-scoped assignment, then revokes it', async ({
  page,
}) => {
  const property = await seedProperty()
  const owner = await createStaff('owner', { mfa: true })
  const target = await createStaff('read_only')
  await signIn(page, owner)

  await page.goto(`/staff/${target.id}`)
  await page.getByLabel('Role').selectOption('manager')
  await page.getByLabel('Access scope').selectOption(`property:${property.id}`)
  await page.getByRole('button', { name: 'Grant access' }).click()

  // Poll the fact, not a UI signal: every control on this page resolves
  // before the write lands, which is the race CLAUDE.md documents.
  await expect
    .poll(async () =>
      prisma.staffAssignment.count({
        where: { staffUserId: target.id, propertyId: property.id, revokedAt: null },
      }),
    )
    .toBe(1)

  // The accessible name carries the role and the scope - a page of
  // identically-named "Revoke" buttons is ambiguous by label and fails
  // strict mode.
  await page.getByRole('button', { name: `Revoke Manager on ${property.name}` }).click()
  await expect
    .poll(async () =>
      prisma.staffAssignment.count({
        where: { staffUserId: target.id, propertyId: property.id, revokedAt: null },
      }),
    )
    .toBe(0)

  // Revoked, never deleted: the row is the evidence the access existed
  // (ROLE-06).
  expect(
    await prisma.staffAssignment.count({
      where: { staffUserId: target.id, propertyId: property.id },
    }),
  ).toBe(1)
})

test('ROLE-06: deactivating a leaver ends the session they are holding', async ({
  browser,
  page,
}) => {
  const owner = await createStaff('owner', { mfa: true })
  const leaver = await createStaff('manager')

  const leaverContext = await browser.newContext()
  await leaverContext.setExtraHTTPHeaders(uniqueClientHeaders())
  const leaverPage = await leaverContext.newPage()
  await signIn(leaverPage, leaver)

  await signIn(page, owner)
  await page.goto(`/staff/${leaver.id}`)
  await page.getByLabel('Why they are leaving (optional)').fill('Left the company')
  await page.getByRole('button', { name: /^Deactivate/ }).click()

  await expect
    .poll(async () =>
      prisma.staffUser
        .findUniqueOrThrow({ where: { id: leaver.id }, select: { active: true } })
        .then((row) => row.active),
    )
    .toBe(false)

  // `auth.ts` caches (active, sessionsValidFrom) for ~30 seconds, so this is
  // the "within a minute" ROLE-06 asks for rather than an instant one.
  await expect
    .poll(
      async () => {
        await leaverPage.goto('/dashboard')
        return leaverPage.url()
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toMatch(/\/login/)

  await leaverContext.close()
})

test('deactivating yourself is refused', async ({ page }) => {
  const owner = await createStaff('owner', { mfa: true })
  await signIn(page, owner)
  await page.goto(`/staff/${owner.id}`)

  await page.getByRole('button', { name: /^Deactivate/ }).click()
  // NOT getByRole('alert'): Next's `#__next-route-announcer__` is a second
  // role="alert" on every page, so the role match is ambiguous by
  // construction. Assert the sentence.
  await expect(page.getByText(/your own account/i)).toBeVisible()

  expect(
    await prisma.staffUser.findUniqueOrThrow({
      where: { id: owner.id },
      select: { active: true },
    }),
  ).toEqual({ active: true })
})

// THE LAST-OWNER REFUSAL IS NOT TESTED HERE, DELIBERATELY. `revokeRefusal`
// asks a question about the whole deployment - "is this the only active owner
// grant left" - and the shared test database holds 1,715 of them from every
// spec that has ever run. The condition cannot be created without emptying a
// database other specs are using, so the rule is covered by
// `apps/web/lib/staff/rules.test.ts`, which reasons over the assignment list
// as a value and does not need one.
//
// The first version of this file asserted it through the UI and passed the
// refusal by accident: with other owners present the revoke was ALLOWED, the
// owner lost their own grant mid-test, and the next request redirected to
// /no-access - which surfaced as "expected /last owner assignment/, received
// 'You don't have access to that'". The product was correct; the test premise
// was impossible.

test('a manager reads the directory and is offered no controls', async ({ page }) => {
  const manager = await createStaff('manager')
  await signIn(page, manager)

  await page.goto('/staff')
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add staff member' })).toHaveCount(0)

  await page.goto(`/staff/${manager.id}`)
  await expect(page.getByRole('button', { name: 'Grant access' })).toHaveCount(0)
  await expect(page.getByText('Changing access needs the Owner role.')).toBeVisible()
})

test('a property-scoped manager cannot reach the directory at all', async ({ page }) => {
  const property = await seedProperty()
  const scoped = await createStaff('manager', { scope: { propertyId: property.id } })
  await signIn(page, scoped)

  // `portfolioOnly` in the nav, and a resource-less guard on the page: a
  // StaffUser carries no propertyId, so there is nothing to scope the
  // directory by and a scoped actor is refused rather than dead-ended.
  await expect(page.getByRole('link', { name: 'Staff' })).toHaveCount(0)
  const response = await page.goto('/staff')
  expect(response!.status()).toBe(200)
  await expect(page).toHaveURL(/\/no-access/)
})

/**
 * TWO DEFECTS FIXED HERE, and the second is why the first went unseen (R-170a).
 *
 * ==========================================================================
 * These three scans DISCARDED THEIR RESULTS. `axeScan` returns the results
 * and every other caller in the suite asserts on them
 * (`expect(results.violations).toEqual([])`); this one awaited the promise
 * and threw the answer away, so all three pages could have been arbitrarily
 * inaccessible and the test would still have been green. A scan that asserts
 * nothing is worse than no scan, because it reads as coverage.
 *
 * THE TIMEOUT HAD NO HEADROOM, which is what made it the last red test on a
 * pipeline this item exists to make trustworthy. Measured in isolation, one
 * worker, no contention: `/staff` **2.2s**, `/staff/new` **20.9s**,
 * `/staff/[id]` **21.8s** - about **45s of a 60s budget spent before any
 * other test is running**. Under a full sweep it goes over and times out
 * inside the third scan, on both projects, which is exactly the "timeout set
 * at the measured cost is a flake generator" pattern CLAUDE.md records
 * against R-102b and R-040e. 180s is deliberately far above the measurement
 * rather than just above it.
 *
 * The 10x spread between the first page and the other two is not noise and is
 * not addressed here: axe's cost is superlinear in node count, so a 21s scan
 * is a page saying it is very large. Left as found, and noted.
 * ==========================================================================
 */
test('the staff screens are accessible', async ({ page }) => {
  test.setTimeout(180_000)
  const owner = await createStaff('owner', { mfa: true })
  const target = await createStaff('manager')
  await signIn(page, owner)

  for (const url of ['/staff', '/staff/new', `/staff/${target.id}`]) {
    await page.goto(url)
    const results = await axeScan(page)
    expect(results.violations, `${url} has axe violations`).toEqual([])
  }
})
