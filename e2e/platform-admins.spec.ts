import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, createAdmin, ensureKeeperOwner, retireAdmins, signIn, submitPassword } from './platform-fixtures.ts'

// `/platform/admins` and the lockout notice (PRD 11 §2.5, §4.8; R-302b).
//
// THE LAST-OWNER REFUSAL IS NOT ASSERTED HERE. It is about every live owner
// in the deployment, and `rental_test` always holds the keeper owner (see
// `ensureKeeperOwner`), so no spec can be the last one. It is covered by
// `platformRevokeRefusal`/`platformDeactivationRefusal` over lists in
// packages/core/rbac/platform.test.ts and by the deferred trigger.

const created: string[] = []

test.beforeAll(ensureKeeperOwner)
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})
test.afterAll(() => retireAdmins(created))

const audits = (action: string, entityId: string) =>
  prisma.auditLog.findMany({ where: { action, entityId, actorType: 'PLATFORM', orgId: null } })

test('an owner invites an admin, who gets a setup link by email and on screen', async ({ page }) => {
  const owner = await createAdmin(true, created, ['platform_owner'])
  await signIn(page, owner)
  await page.getByRole('link', { name: 'Platform admins' }).click()
  await expect(page.getByRole('heading', { name: 'Platform admins' })).toBeVisible()
  await page.getByRole('link', { name: 'Invite an admin' }).click()

  const email = `invited-${randomUUID()}@example.test`
  await page.getByLabel('Full name').fill('Invited Admin')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Platform role').selectOption('platform_viewer')
  await page.getByRole('button', { name: 'Invite and send setup link' }).click()
  await expect(page.getByText(/Invited Admin is invited/)).toBeVisible()
  await expect(page.locator('code')).toContainText('/platform/set-password?token=')

  const invited = await prisma.platformAdmin.findUniqueOrThrow({ where: { email }, include: { roles: true } })
  created.push(invited.id)
  expect(invited.createdById).toBe(owner.id)
  expect(invited.roles.map((r) => [r.roleKey, r.grantedById])).toEqual([['platform_viewer', owner.id]])
  expect(await audits('platform_admin.created', invited.id)).toHaveLength(1)
  const [sent] = await audits('platform_admin.setup_link_sent', invited.id)
  expect(sent?.after).toMatchObject({ to: email, status: 'SENT' })

  // A second invite to the same address is refused.
  await page.getByLabel('Full name').fill('Invited Again')
  await page.getByLabel('Email address').fill(email.toUpperCase())
  await page.getByLabel('Platform role').selectOption('platform_viewer')
  await page.getByRole('button', { name: 'Invite and send setup link' }).click()
  await expect(page.getByText(`${email} is already a platform admin.`)).toBeVisible()
})

test('an owner grants, revokes, resets and deactivates another admin', async ({ page }) => {
  const owner = await createAdmin(true, created, ['platform_owner'])
  const other = await createAdmin(true, created, ['platform_support'])
  await signIn(page, owner)
  await page.goto(`${CONSOLE}/platform/admins/${other.id}`)
  await expect(page.getByRole('heading', { name: other.name })).toBeVisible()
  // Enrolled, so a setup link is refused before the press.
  await expect(page.getByText(`${other.name} has already finished setting up their account.`)).toBeVisible()

  await page.getByLabel('Role to grant').selectOption('platform_viewer')
  await page.getByRole('button', { name: 'Grant role' }).click()
  await expect(page.getByText(`${other.name} now holds Platform viewer.`)).toBeVisible()

  await page.getByRole('button', { name: 'Revoke Platform viewer' }).click()
  await expect(page.getByText(`${other.name} no longer holds Platform viewer.`)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Revoked roles' })).toBeVisible()

  await page.getByRole('button', { name: 'Reset two-factor' }).click()
  await expect(page.getByText(/two-factor is cleared/)).toBeVisible()
  const credential = await prisma.platformCredential.findUniqueOrThrow({ where: { platformAdminId: other.id } })
  expect(credential.mfaEnrolledAt).toBeNull()

  await page.getByRole('button', { name: 'Deactivate' }).click()
  await expect(page.getByText(/is deactivated. Every session they held has ended./)).toBeVisible()
  expect((await prisma.platformAdmin.findUniqueOrThrow({ where: { id: other.id } })).active).toBe(false)

  for (const action of ['platform_role.granted', 'platform_role.revoked', 'auth.mfa_reset', 'platform_admin.deactivated']) {
    expect(await audits(action, other.id), action).toHaveLength(1)
  }
})

test('an owner cannot change their own roles or account, and is told before pressing', async ({ page }) => {
  const owner = await createAdmin(true, created, ['platform_owner'])
  await signIn(page, owner)
  await page.goto(`${CONSOLE}/platform/admins/${owner.id}`)
  await expect(page.getByText('You cannot change your own roles. Ask another platform owner.')).toBeVisible()
  await expect(page.getByText(/You cannot reset your own two-factor here/)).toBeVisible()
  await expect(page.getByText('You cannot deactivate your own account. Ask another platform owner.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Grant role' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Deactivate' })).toHaveCount(0)
})

test('an admin without platformAdmin.manage never sees the roster', async ({ page }) => {
  const viewer = await createAdmin(true, created, ['platform_viewer'])
  await signIn(page, viewer)
  await page.goto(`${CONSOLE}/platform/admins`)
  await expect(page.getByRole('heading', { name: 'You don’t have access to that' })).toBeVisible()
})

test('a lockout emails every other active platform owner', async ({ page }) => {
  const owner = await createAdmin(true, created, ['platform_owner'])
  const locked = await createAdmin(true, created)
  for (let attempt = 0; attempt < 5; attempt++) {
    // A fresh address each time, so the per-IP limit (also five) cannot answer first.
    await page.setExtraHTTPHeaders(uniqueClientHeaders())
    await submitPassword(page, locked.email, 'not-the-password-at-all')
    await expect(page.getByText(/did not match an account/)).toBeVisible()
  }
  // Sent after the response, so poll for the row.
  await expect
    .poll(async () => (await audits('auth.lockout_notified', locked.id))[0]?.after, { timeout: 15_000 })
    .toMatchObject({ sent: expect.arrayContaining([{ recipientId: owner.id, status: 'SENT' }]) })
})
