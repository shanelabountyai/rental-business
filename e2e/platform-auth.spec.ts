import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { type BrowserContext, expect, test } from '@playwright/test'
import { decode, encode } from 'next-auth/jwt'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, PASSWORD, code, createAdmin as fixtureAdmin, retireAdmins, signIn, submitPassword } from './platform-fixtures.ts'

// The platform console's sign-in (PRD 11 §2, R-294b). PLATFORM_HOST is
// `platform.localhost` for the e2e server (playwright.config.ts); Chromium
// resolves it to loopback, so the same server on the same port answers both
// hosts and the host alone decides which product it is.
//
// Admins cannot be deleted (trigger), so each test makes its own and
// deactivates it afterwards.

const ORG = `http://localhost:${process.env.PORT ?? '3100'}`
const created: string[] = []
const createAdmin = (enrolled: boolean) => fixtureAdmin(enrolled, created)

const PLATFORM_COOKIE = '__Host-platform.session-token'
const ORG_COOKIE = 'authjs.session-token'

async function sessionCookie(context: BrowserContext) {
  return (await context.cookies(CONSOLE)).find((c) => c.name === PLATFORM_COOKIE)!
}

/// Re-seals the session as if its last code were eleven minutes old - the
/// server's clock cannot be moved, the token's claim can.
async function ageStepUp(context: BrowserContext) {
  const cookie = await sessionCookie(context)
  const secret = process.env.AUTH_SECRET!
  const token = (await decode({ token: cookie.value, secret, salt: PLATFORM_COOKIE }))!
  token.mfaVerifiedAt = Date.now() - 11 * 60_000
  const value = await encode({ token, secret, salt: PLATFORM_COOKIE, maxAge: 30 * 60 })
  await context.addCookies([{ ...cookie, value }])
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await retireAdmins(created)
})

test('signs in with password and code, in a __Host- cookie, and dies with the admin', async ({
  page,
  context,
}) => {
  const admin = await createAdmin(true)
  await submitPassword(page, admin.email)
  await expect(page).toHaveURL(/\/platform\/login\/mfa$/)

  // The password alone made no session.
  await page.goto(`${CONSOLE}/platform`)
  await expect(page).toHaveURL(/\/platform\/login$/)
  await page.goBack()

  await page.getByLabel(/code/i).fill(code(admin.secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Platform console' })).toBeVisible()
  expect(page.url()).toBe(`${CONSOLE}/platform`)

  const session = (await context.cookies(CONSOLE)).find((c) => c.name === '__Host-platform.session-token')
  expect(session?.secure).toBe(true)
  expect(session?.domain).toBe('platform.localhost')

  expect(
    await prisma.auditLog.count({
      where: { action: 'auth.signed_in', entityId: admin.id, actorType: 'PLATFORM', orgId: null },
    }),
  ).toBe(1)

  // Deactivation kills the session on its next request (§2.7).
  await prisma.platformAdmin.update({ where: { id: admin.id }, data: { active: false } })
  await page.goto(`${CONSOLE}/platform`)
  await expect(page).toHaveURL(/\/platform\/login$/)
})

test('an admin with no second factor enrols before reaching anything', async ({ page }) => {
  const admin = await createAdmin(false)
  await submitPassword(page, admin.email)
  await expect(page).toHaveURL(/\/platform\/enrol-mfa$/)

  await page.goto(`${CONSOLE}/platform`)
  await expect(page).toHaveURL(/\/platform\/login$/)
  await page.goto(`${CONSOLE}/platform/enrol-mfa`)

  await page.getByRole('button', { name: 'Set up two-factor authentication' }).click()
  const secret = (await page.locator('code').textContent())!.trim()
  await page.getByLabel('Code from your authenticator app').fill(code(secret))
  await page.getByRole('button', { name: 'Turn on two-factor' }).click()

  await expect(page.getByText('These will not be shown again.')).toBeVisible()
  await expect(page.locator('ul li')).toHaveCount(10)
  await page.getByRole('link', { name: /continue/ }).click()
  await expect(page.getByRole('heading', { name: 'Platform console' })).toBeVisible()

  const credential = await prisma.platformCredential.findUniqueOrThrow({ where: { platformAdminId: admin.id } })
  expect(credential.mfaEnrolledAt).not.toBeNull()
  // Sealed under its own purpose: staff's key cannot open it.
  expect(credential.mfaSecret).not.toContain(secret)
})

test("the bootstrap script's link sets the first password, once", async ({ page }) => {
  const admin = await createAdmin(false)
  const setup = mintToken('PLATFORM_PASSWORD_SETUP')
  await prisma.authToken.create({
    data: {
      purpose: 'PLATFORM_PASSWORD_SETUP',
      tokenHash: setup.tokenHash,
      subjectType: 'PlatformAdmin',
      subjectId: admin.id,
      expiresAt: setup.expiresAt,
    },
  })
  const link = `${CONSOLE}/platform/set-password?token=${setup.token}`
  const fresh = 'a-brand-new-platform-passphrase'
  await page.goto(link)
  await page.getByLabel('New password', { exact: true }).fill(fresh)
  await page.getByLabel('Confirm new password').fill(fresh)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByText('Your password is set. Sign in with it.')).toBeVisible()

  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('Password').fill(fresh)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/platform\/enrol-mfa$/)

  // Single use.
  await page.goto(link)
  await page.getByLabel('New password', { exact: true }).fill(fresh)
  await page.getByLabel('Confirm new password').fill(fresh)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByText('That link is no longer valid. Ask for a new one.')).toBeVisible()
})

test('a wrong password and an unknown address read the same', async ({ page }) => {
  const admin = await createAdmin(true)
  await submitPassword(page, `nobody-${randomUUID()}@example.test`)
  const unknown = await page.getByRole('alert').filter({ hasText: /did not match/ }).textContent()
  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('Password').fill('not-the-password-at-all')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText(unknown!.trim())).toBeVisible()
})

test('each host serves only its own product', async ({ request }) => {
  const headers = uniqueClientHeaders()
  for (const url of [
    `${ORG}/platform/login`,
    `${ORG}/platform/api/auth/session`,
    `${CONSOLE}/dashboard`,
    `${CONSOLE}/login`,
    `${CONSOLE}/api/auth/session`,
  ]) {
    expect((await request.get(url, { headers, maxRedirects: 0 })).status(), url).toBe(404)
  }
  expect((await request.get(`${CONSOLE}/platform/login`, { headers })).status()).toBe(200)
  expect((await request.get(`${ORG}/login`, { headers })).status()).toBe(200)
})

test('a stale code sends a sensitive press through step-up, and back', async ({ page, context }) => {
  const admin = await createAdmin(true)
  await signIn(page, admin)
  await page.getByRole('link', { name: 'Your account' }).click()
  await expect(page.getByRole('heading', { name: 'Your platform account' })).toBeVisible()
  await expect(page.getByText(admin.email)).toBeVisible()

  await ageStepUp(context)
  await page.getByRole('button', { name: 'Regenerate recovery codes' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('next')).toBe('/platform/account')

  await page.getByLabel(/code/i).fill('000000')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('That code was not right. Check your authenticator app.')).toBeVisible()

  await page.getByLabel(/code/i).fill(code(admin.secret))
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('heading', { name: 'Your platform account' })).toBeVisible()

  await page.getByRole('button', { name: 'Regenerate recovery codes' }).click()
  await expect(page.getByRole('list', { name: 'New recovery codes' }).getByRole('listitem')).toHaveCount(10)
  const credential = await prisma.platformCredential.findUniqueOrThrow({ where: { platformAdminId: admin.id } })
  expect(credential.mfaRecoveryCodes).toHaveLength(10)
  for (const action of ['auth.step_up', 'auth.recovery_codes_regenerated']) {
    expect(
      await prisma.auditLog.count({ where: { action, entityId: admin.id, actorType: 'PLATFORM', orgId: null } }),
      action,
    ).toBe(1)
  }
})

test('the step-up page will not send anyone off the console', async ({ page }) => {
  const admin = await createAdmin(true)
  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/step-up?next=${encodeURIComponent('//evil.example/platform')}`)
  await page.getByLabel(/code/i).fill(code(admin.secret))
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('heading', { name: 'Platform console' })).toBeVisible()
  expect(page.url()).toBe(`${CONSOLE}/platform`)
})

test('signing out everywhere kills a copy of the session too', async ({ page, context }) => {
  const admin = await createAdmin(true)
  await signIn(page, admin)
  const copy = await sessionCookie(context)
  await page.goto(`${CONSOLE}/platform/account`)
  await page.getByRole('button', { name: 'Sign out of every device' }).click()
  await expect(page).toHaveURL(/\/platform\/login$/)

  await context.addCookies([copy])
  await page.goto(`${CONSOLE}/platform`)
  await expect(page).toHaveURL(/\/platform\/login$/)
})

// PLAT-09 (PRD 11 §7.1): no session crosses hosts. Each half first proves the
// cookie works where it belongs - the control - then plants it on the other
// host under both names, and the other product must see nobody. The support
// session half arrives with support sessions (R-295).
test('PLAT-09: a platform session is nobody on an org host', async ({ page, context }) => {
  const admin = await createAdmin(true)
  await signIn(page, admin)
  const platform = await sessionCookie(context)
  await page.goto(`${CONSOLE}/platform`)
  await expect(page.getByRole('heading', { name: 'Platform console' })).toBeVisible()

  await context.addCookies(
    [PLATFORM_COOKIE, ORG_COOKIE].map((name) => ({
      name,
      value: platform.value,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax' as const,
    })),
  )
  await page.goto(`${ORG}/dashboard`)
  await expect(page).toHaveURL(/\/login(\?|$)/)
  expect((await page.request.get(`${ORG}/platform`, { maxRedirects: 0 })).status()).toBe(404)
})

test('PLAT-09: an org session is nobody on the console host', async ({ page, context }) => {
  const staff = await prisma.staffUser.create({
    data: {
      email: `plat-09-${randomUUID()}@example.test`,
      name: 'Org Staff',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
      orgMemberships: { create: { orgId: 'org_0' } },
    },
  })
  try {
    await page.goto(`${ORG}/login`)
    await page.getByLabel('Email').fill(staff.email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    // Role-less, so the org answers /no-access - signed in, which is the control.
    await expect(page).toHaveURL(/\/no-access/)
    const org = (await context.cookies(ORG)).find((c) => c.name === ORG_COOKIE)!
    expect(org).toBeDefined()

    await context.addCookies(
      [PLATFORM_COOKIE, ORG_COOKIE].map((name) => ({
        name,
        value: org.value,
        domain: 'platform.localhost',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax' as const,
      })),
    )
    await page.goto(`${CONSOLE}/platform/account`)
    await expect(page).toHaveURL(/\/platform\/login$/)
    expect((await page.request.get(`${CONSOLE}/dashboard`, { maxRedirects: 0 })).status()).toBe(404)
  } finally {
    await prisma.staffUser.update({ where: { id: staff.id }, data: { active: false } })
  }
})
