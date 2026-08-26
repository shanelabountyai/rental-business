import { randomUUID } from 'node:crypto'
import {
  createTotpEnrolment,
  hashPassword,
  hashToken,
  mintRecoveryCodes,
  mintToken,
  sealSecret,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { axeScan } from './fixtures.ts'

// End-to-end coverage of R-003. Two things here cannot be tested any other
// way, and both are load-bearing:
//
//   ROLE-06 revocation. Auth.js Credentials sessions are JWTs, so "kill access
//   within a minute" rests on the jwt callback re-reading the account on every
//   request and returning null when it is no longer valid. Whether returning
//   null actually destroys the session is framework behaviour, not something
//   to take on trust - so it is asserted against a real browser and a real
//   cookie rather than assumed from the docs.
//
//   The accessibility of the tenant-facing sign-in page. WCAG 2.1 AA is an
//   acceptance criterion on tenant-facing work (CLAUDE.md), and this is the
//   first tenant-facing surface in the product.

const PASSWORD = 'correct-horse-battery-staple'

/** Unique per test so the two viewport projects never collide on shared rows. */
function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID()}@example.test`
}

const createdStaffIds: string[] = []
const createdTenantIds: string[] = []

async function createStaffUser(options: { active?: boolean } = {}) {
  const email = uniqueEmail('staff')
  const staffUser = await prisma.staffUser.create({
    data: {
      email,
      name: 'Test Manager',
      active: options.active ?? true,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  createdStaffIds.push(staffUser.id)
  return { ...staffUser, password: PASSWORD }
}

async function createTenant() {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Dana',
      lastName: 'Reyes',
      email: uniqueEmail('tenant'),
    },
  })
  createdTenantIds.push(tenant.id)
  return tenant
}

/** Mints a magic link the way the action would, without needing email. */
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

/**
 * Next injects its own `role="alert"` route announcer into every page, so a
 * bare getByRole('alert') is ambiguous. Scoping to the form also asserts
 * something real: the error belongs to the form the user just submitted.
 */
function formAlert(page: import('@playwright/test').Page) {
  return page.locator('form').getByRole('alert')
}

// Every test otherwise signs in from the same host and shares one per-IP login
// bucket, so tests would exhaust each other's budget and fail on rate limiting
// instead of on what they assert.
//
// Giving each test its own simulated client address is better than clearing
// the counters between tests: clearing is shared mutable state, and the two
// viewport projects run in parallel, so one project's cleanup lands in the
// middle of the other's brute-force test. This way nothing is shared and the
// limiter is exercised for real, per test.
//
// x-forwarded-for is only trusted here because it is trusted in development.
// In production Vercel's proxy overwrites it, which is what makes the header
// meaningful there and spoofable here.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.authToken.deleteMany({
    where: { subjectId: { in: [...createdStaffIds, ...createdTenantIds] } },
  })
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: createdStaffIds } },
  })
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: createdStaffIds } },
  })
  // A staff user who has signed in has AuditLog rows pointing at them, and
  // AuditLog is append-only - so the foreign key cannot be nulled and the row
  // CANNOT BE DELETED. That is the intended product behaviour, not a test
  // problem: ROLE-06 says deactivate and preserve history, never delete, and
  // R-002 made actorStaffId a real foreign key precisely so the database
  // enforces it. Test rows are subject to the same rule, so audited ones are
  // deactivated and left behind.
  const audited = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: createdStaffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffUser.deleteMany({
    where: { id: { in: createdStaffIds.filter((id) => !audited.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...audited] } },
    data: { active: false, deactivatedAt: new Date() },
  })
  await prisma.tenantCredential.deleteMany({
    where: { tenantId: { in: createdTenantIds } },
  })
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } })
  await prisma.$disconnect()
})

/**
 * Grants a role. Since R-007, sign-in lands on /dashboard, which needs
 * `property.read` - so a test that wants to see the dashboard has to give its
 * user a role first. A role-less staff user is redirected to /no-access, which
 * is correct behaviour and has its own tests.
 */
async function grantRole(staffUserId: string, roleKey: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: { staffUserId, roleId: role.id },
  })
}

async function signInAsStaff(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Sign-in lands on the dashboard now that R-007's shell exists.
  await page.waitForURL('**/dashboard')
}

test.describe('accessibility', () => {
  for (const path of [
    '/login',
    '/login/mfa',
    '/forgot-password',
    '/portal/login',
  ]) {
    test(`${path} has no detectable accessibility violations`, async ({
      page,
    }) => {
      await page.goto(path)
      const results = await axeScan(page)
      expect(results.violations).toEqual([])
    })
  }

  test('every auth form field has a real label', async ({ page }) => {
    await page.goto('/login')
    // getByLabel only resolves through a proper label association, so this
    // failing means someone used a placeholder as a label.
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
  })
})

test.describe('route protection', () => {
  test('sends an anonymous visitor from /dashboard to the staff sign-in', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
  })

  test('sends an anonymous visitor from /account to the staff sign-in', async ({
    page,
  }) => {
    await page.goto('/account')
    await expect(page).toHaveURL(/\/login/)
  })

  test('sends an anonymous visitor from /portal to the tenant sign-in', async ({
    page,
  }) => {
    await page.goto('/portal')
    await expect(page).toHaveURL(/\/portal\/login/)
  })
})

test.describe('staff sign-in', () => {
  test('signs in with the right password', async ({ page }) => {
    const staff = await createStaffUser()
    await grantRole(staff.id, 'owner')
    await signInAsStaff(page, staff.email)
    await expect(
      page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toBeVisible()
  })

  test('rejects the wrong password without saying why', async ({ page }) => {
    const staff = await createStaffUser()
    await page.goto('/login')
    await page.getByLabel('Email').fill(staff.email)
    await page.getByLabel('Password').fill('definitely-not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const alert = formAlert(page)
    await expect(alert).toBeVisible()
    // No user enumeration: the message must not distinguish a wrong password
    // from an address that has no account.
    await expect(alert).toHaveText(
      'Those details did not match an account. Check them and try again.',
    )
    await expect(page).toHaveURL(/\/login/)
  })

  test('gives an unknown address the identical message', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(uniqueEmail('nobody'))
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(formAlert(page)).toHaveText(
      'Those details did not match an account. Check them and try again.',
    )
  })

  test('refuses a deactivated account', async ({ page }) => {
    const staff = await createStaffUser({ active: false })
    await page.goto('/login')
    await page.getByLabel('Email').fill(staff.email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(formAlert(page)).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('staff MFA', () => {
  /** A staff account already through enrolment, with a known TOTP secret. */
  async function createEnrolledStaff() {
    const staff = await createStaffUser()
    const { secret } = createTotpEnrolment(staff.email)
    const recovery = mintRecoveryCodes(3)
    await prisma.staffCredential.update({
      where: { staffUserId: staff.id },
      data: {
        mfaSecret: sealSecret(secret),
        mfaEnrolledAt: new Date(),
        mfaRecoveryCodes: recovery.hashes,
      },
    })
    return { ...staff, secret, recoveryCodes: recovery.codes }
  }

  function currentCode(secret: string) {
    return new TOTP({ secret: Secret.fromBase32(secret) }).generate()
  }

  async function submitPassword(
    page: import('@playwright/test').Page,
    email: string,
  ) {
    await page.goto('/login')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }

  test('asks for a second factor and does not sign in on the password alone', async ({
    page,
  }) => {
    const staff = await createEnrolledStaff()
    await submitPassword(page, staff.email)

    await expect(page).toHaveURL(/\/login\/mfa/)
    // The password alone must not have produced a session.
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
  })

  test('signs in with a correct authenticator code', async ({ page }) => {
    const staff = await createEnrolledStaff()
    await grantRole(staff.id, 'owner')
    await submitPassword(page, staff.email)
    await expect(page).toHaveURL(/\/login\/mfa/)

    await page.getByLabel(/code/i).fill(currentCode(staff.secret))
    await page.getByRole('button', { name: 'Verify' }).click()

    await page.waitForURL('**/dashboard')
    await expect(
      page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toBeVisible()
  })

  // A typo must not burn the challenge, or one slip sends the user back to the
  // password screen - which is how people end up disabling MFA.
  test('survives a wrong code and still accepts the right one', async ({
    page,
  }) => {
    const staff = await createEnrolledStaff()
    await submitPassword(page, staff.email)

    await page.getByLabel(/code/i).fill('000000')
    await page.getByRole('button', { name: 'Verify' }).click()

    // Wait for the message the user would actually see before retrying, rather
    // than racing the first submission - and assert it is the friendly "try
    // again", not an error page.
    await expect(formAlert(page)).toHaveText(
      'That code was not right. Check your authenticator app.',
    )
    await expect(page).toHaveURL(/\/login\/mfa/)

    await page.getByLabel(/code/i).fill(currentCode(staff.secret))
    await page.getByRole('button', { name: 'Verify' }).click()
    await page.waitForURL('**/dashboard')
  })

  test('accepts a recovery code and spends it', async ({ page }) => {
    const staff = await createEnrolledStaff()
    await submitPassword(page, staff.email)

    const used = staff.recoveryCodes[0]!
    await page.getByLabel(/code/i).fill(used)
    await page.getByRole('button', { name: 'Verify' }).click()
    await page.waitForURL('**/dashboard')

    const credential = await prisma.staffCredential.findUnique({
      where: { staffUserId: staff.id },
    })
    // Spent, so a stolen printout cannot be replayed.
    expect(credential!.mfaRecoveryCodes).toHaveLength(2)
    expect(credential!.mfaRecoveryCodes).not.toContain(hashToken(used))
  })
})

test.describe('authorization (R-004)', () => {
  async function grant(
    staffUserId: string,
    roleKey: string,
    scope: { propertyId?: string; legalEntityId?: string } = {},
  ) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
    await prisma.staffAssignment.create({
      data: { staffUserId, roleId: role.id, ...scope },
    })
  }

  test('shows a staff user with no roles that they have none', async ({
    page,
  }) => {
    const staff = await createStaffUser()
    await signInAsStaff(page, staff.email)
    await page.goto('/account')
    // Deny by default is visible, not silent: a signed-in user with no
    // assignment can do nothing, and the page says so rather than looking
    // like an empty dashboard.
    await expect(page.getByText(/You have no roles yet/)).toBeVisible()
  })

  test('shows an owner their portfolio-wide grant and no ceiling', async ({
    page,
  }) => {
    const staff = await createStaffUser()
    await grant(staff.id, 'owner')
    await signInAsStaff(page, staff.email)
    await page.goto('/account')

    await expect(page.getByText('Owner —')).toBeVisible()
    // Scoped to the assignment list: the property switcher in the header now
    // renders "All properties" too, so a bare text match is ambiguous.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Owner —' }),
    ).toContainText('all properties')
    // Null ceiling reads as unlimited - there is nobody above the owner to
    // route an approval up to.
    await expect(page.getByText('No limit').first()).toBeVisible()
  })

  test("shows a manager their role's seeded ceilings", async ({ page }) => {
    const staff = await createStaffUser()
    await grant(staff.id, 'manager')
    await signInAsStaff(page, staff.email)
    await page.goto('/account')

    await expect(page.getByText('Manager —')).toBeVisible()
    await expect(page.getByText('$500.00')).toBeVisible()
    await expect(page.getByText('$100.00')).toBeVisible()
  })

  test('honours a personal ceiling override of zero', async ({ page }) => {
    const staff = await createStaffUser()
    await grant(staff.id, 'manager')
    // Zero means "may approve nothing" and must not fall back to the role
    // default - the `||` bug, asserted end to end.
    await prisma.staffUser.update({
      where: { id: staff.id },
      data: { approveWorkOrderCents: 0 },
    })
    await signInAsStaff(page, staff.email)
    await page.goto('/account')

    await expect(page.getByText('$0.00')).toBeVisible()
    await expect(page.getByText('$500.00')).toHaveCount(0)
  })

  // Revoking has to bite on the very next request, not at session expiry
  // (ROLE-06). Permissions are read per request, so this needs no sign-out.
  test('drops access the moment an assignment is revoked', async ({ page }) => {
    const staff = await createStaffUser()
    await grant(staff.id, 'owner')
    await signInAsStaff(page, staff.email)
    await page.goto('/account')
    await expect(page.getByText('Owner —')).toBeVisible()

    await prisma.staffAssignment.updateMany({
      where: { staffUserId: staff.id },
      data: { revokedAt: new Date() },
    })

    await page.reload()
    await expect(page.getByText(/You have no roles yet/)).toBeVisible()
    await expect(page.getByText('Owner —')).toHaveCount(0)
  })

  test('the account page has no accessibility violations', async ({ page }) => {
    const staff = await createStaffUser()
    await grant(staff.id, 'manager')
    await signInAsStaff(page, staff.email)
    await page.goto('/account')

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})

test.describe('brute-force resistance', () => {
  // The beforeEach above clears rate-limit state so the rest of the suite can
  // sign in freely. This test is where that protection is actually asserted,
  // so clearing it elsewhere does not quietly delete the coverage.
  test('stops repeated wrong-password attempts from one address', async ({
    page,
  }) => {
    const staff = await createStaffUser()

    // The per-IP login budget is 10 in five minutes; go past it.
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.goto('/login')
      await page.getByLabel('Email').fill(staff.email)
      await page.getByLabel('Password').fill(`wrong-guess-number-${attempt}`)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(formAlert(page)).toBeVisible()
    }

    await expect(formAlert(page)).toHaveText(
      'Too many attempts. Wait a few minutes and try again.',
    )

    // And the account itself is locked, so switching IP does not help: the
    // correct password is refused too.
    const credential = await prisma.staffCredential.findUnique({
      where: { staffUserId: staff.id },
    })
    expect(credential!.failedLoginCount).toBeGreaterThanOrEqual(5)
    expect(credential!.lockedUntil).not.toBeNull()
  })
})

test.describe('session revocation (ROLE-06)', () => {
  // The whole reason the jwt callback pays for a database read on every
  // request. If this test fails, "access killed within 1 minute" is a comment
  // rather than a behaviour.
  test('deactivating a signed-in user kills their session on the next request', async ({
    page,
  }) => {
    const staff = await createStaffUser()
    await signInAsStaff(page, staff.email)

    await prisma.staffUser.update({
      where: { id: staff.id },
      data: { active: false, deactivatedAt: new Date() },
    })

    await page.goto('/account')
    await expect(page).toHaveURL(/\/login/)
  })

  test('moving the sessionsValidFrom watermark kills existing sessions', async ({
    page,
  }) => {
    const staff = await createStaffUser()
    await signInAsStaff(page, staff.email)

    // What a password reset and "sign out everywhere" both do.
    await prisma.staffUser.update({
      where: { id: staff.id },
      data: { sessionsValidFrom: new Date(Date.now() + 1000) },
    })

    await page.goto('/account')
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('tenant magic link', () => {
  test('signs a tenant in and lands them in the portal', async ({ page }) => {
    const tenant = await createTenant()
    await page.goto(await magicLinkFor(tenant.id))

    await expect(page).toHaveURL(/\/portal$/)
    // "Hello, Dana", not "Welcome, Dana Reyes": R-018 replaced the R-003
    // placeholder with the real portal, which greets people by first name in
    // the plainer register §6.4 asks for. The assertion here only needs to
    // prove the magic link landed a real session on a real page.
    await expect(
      page.getByRole('heading', { name: /Hello, Dana/, level: 1 }),
    ).toBeVisible()
  })

  // §6.1: "short-lived and single-use". A forwarded link must be spent.
  test('refuses the same link a second time', async ({ page, context }) => {
    const tenant = await createTenant()
    const link = await magicLinkFor(tenant.id)

    await page.goto(link)
    await expect(page).toHaveURL(/\/portal$/)

    // A different browser context, so the second attempt carries no session
    // and has to stand on the token alone.
    const fresh = await context.browser()!.newPage()
    await fresh.goto(`${page.url().replace(/\/portal$/, '')}${link}`)
    await expect(fresh).toHaveURL(/\/portal\/login/)
    await fresh.close()
  })

  test('refuses a token that was never issued', async ({ page }) => {
    await page.goto('/portal/verify?token=not-a-real-token')
    await expect(page).toHaveURL(/\/portal\/login/)
  })

  test('does not reveal whether an address is on a lease', async ({ page }) => {
    await page.goto('/portal/login')
    await page.getByLabel('Email').fill(uniqueEmail('nobody'))
    await page.getByRole('button', { name: 'Email me a link' }).click()

    await expect(page.getByRole('status')).toContainText(
      'If that address is on a lease',
    )
  })
})
