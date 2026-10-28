import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import type { PlatformRoleKey } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { type Page, expect } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// Platform console fixtures (R-294b, shared from R-302b). PLATFORM_HOST is
// `platform.localhost` for the e2e server; Chromium resolves it to loopback.
// Admins cannot be deleted (trigger), so each spec deactivates its own.

const PORT = process.env.PORT ?? '3100'
export const CONSOLE = `http://platform.localhost:${PORT}`
export const PASSWORD = 'correct-horse-battery-staple'

export async function createAdmin(enrolled: boolean, created: string[], roles: PlatformRoleKey[] = []) {
  const email = `platform-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const admin = await prisma.platformAdmin.create({
    data: {
      email,
      name: `Platform Tester ${email.slice(9, 15)}`,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          ...(enrolled && { mfaSecret: sealSecret(secret, 'platform-mfa'), mfaEnrolledAt: new Date() }),
        },
      },
      roles: { create: roles.map((roleKey) => ({ roleKey })) },
    },
  })
  created.push(admin.id)
  return { ...admin, secret }
}

export const code = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret) }).generate()

export async function submitPassword(page: Page, email: string, password = PASSWORD) {
  await page.goto(`${CONSOLE}/platform/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

export async function signIn(page: Page, admin: { email: string; secret: string }) {
  await submitPassword(page, admin.email)
  await page.getByLabel(/code/i).fill(code(admin.secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('heading', { name: 'Platform console' })).toBeVisible()
}

/**
 * THE LAST-OWNER TRIGGER IS ABOUT THE WHOLE DEPLOYMENT (R-302a), and so is
 * `rental_test`: once any owner grant exists, the last live one can never be
 * revoked or deactivated, so a spec that deactivates its owners in `afterAll`
 * would be refused by whichever finished last. This owner has no credential,
 * so it can never sign in, and it is never deactivated - it is what lets
 * every spec's owners be retired. Idempotent and race-safe across workers.
 */
export async function ensureKeeperOwner() {
  const email = 'platform-keeper@example.test'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const keeper = await prisma.platformAdmin.upsert({
        where: { email },
        create: { email, name: 'Fixture keeper (never signs in)' },
        update: {},
      })
      const live = await prisma.platformRoleAssignment.findFirst({
        where: { platformAdminId: keeper.id, roleKey: 'platform_owner', revokedAt: null },
      })
      if (!live) await prisma.platformRoleAssignment.create({ data: { platformAdminId: keeper.id, roleKey: 'platform_owner' } })
      return
    } catch (error) {
      // Another worker won the same unique insert; the retry finds its row.
      if (attempt === 2) throw error
    }
  }
}

export async function retireAdmins(ids: string[]) {
  await prisma.platformAdmin.updateMany({ where: { id: { in: ids } }, data: { active: false, deactivatedAt: new Date() } })
}
