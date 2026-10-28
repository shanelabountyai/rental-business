import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, mintToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { type Page, expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniqueClientHeaders } from './fixtures.ts'

// The platform console's sign-in (PRD 11 §2, R-294b). PLATFORM_HOST is
// `platform.localhost` for the e2e server (playwright.config.ts); Chromium
// resolves it to loopback, so the same server on the same port answers both
// hosts and the host alone decides which product it is.
//
// Admins cannot be deleted (trigger), so each test makes its own and
// deactivates it afterwards.

const PORT = process.env.PORT ?? '3100'
const CONSOLE = `http://platform.localhost:${PORT}`
const ORG = `http://localhost:${PORT}`
const PASSWORD = 'correct-horse-battery-staple'
const created: string[] = []

async function createAdmin(enrolled: boolean) {
  const email = `platform-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const admin = await prisma.platformAdmin.create({
    data: {
      email,
      name: 'Platform Tester',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          ...(enrolled && {
            mfaSecret: sealSecret(secret, 'platform-mfa'),
            mfaEnrolledAt: new Date(),
          }),
        },
      },
    },
  })
  created.push(admin.id)
  return { ...admin, secret }
}

const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret) }).generate()

async function submitPassword(page: Page, email: string) {
  await page.goto(`${CONSOLE}/platform/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.platformAdmin.updateMany({
    where: { id: { in: created } },
    data: { active: false, deactivatedAt: new Date() },
  })
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
