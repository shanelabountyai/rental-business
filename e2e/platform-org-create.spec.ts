import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, PASSWORD, createAdmin, ensureKeeperOwner, retireAdmins, signIn } from './platform-fixtures.ts'

// Create an organisation and accept its owner's invite (PRD 11 §4.5, §4.17,
// R-304a). The link is built on `<slug>.orgs.localhost` (ORG_BASE_DOMAIN in
// playwright.config.ts), which Chromium resolves to this same server, so the
// acceptance really happens on the new org's own host.

const admins: string[] = []
const users: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: users } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: users } }, data: { active: false } })
  await retireAdmins(admins)
})

test('a platform owner creates an org, and its owner accepts on the org host', async ({ page }, testInfo) => {
  await ensureKeeperOwner()
  const admin = await createAdmin(true, admins, ['platform_owner'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-new-${tag}`
  const ownerEmail = `new-owner-${tag}@example.test`

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs`)
  await page.getByRole('link', { name: 'Create an organisation' }).click()
  await page.getByLabel('Organisation name').fill(`New Org ${tag}`)
  await page.getByLabel('Slug (its web address)').fill(slug)
  await page.getByLabel("Owner's full name").fill('Nora Newowner')
  await page.getByLabel("Owner's email address").fill(ownerEmail)
  await page.getByRole('button', { name: 'Create and invite the owner' }).click()
  await expect(page.getByText(/is invited as its owner/)).toBeVisible()
  const link = (await page.locator('code').textContent())!.trim()
  expect(link).toContain(`://${slug}.orgs.localhost:`)

  // The org page lists the pending invite with its acts.
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)
  await expect(page.getByRole('button', { name: `Resend the invitation to ${ownerEmail}` })).toBeVisible()

  await page.goto(link)
  await expect(page.getByRole('heading', { name: `Join New Org ${tag}` })).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Set password and join' }).click()
  await expect(page.getByText('Your invitation is accepted.')).toBeVisible()
  expect(new URL(page.url()).hostname).toBe(`${slug}.orgs.localhost`)

  const user = await prisma.staffUser.findUniqueOrThrow({ where: { email: ownerEmail } })
  users.push(user.id)
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug } })
  expect(
    await prisma.staffAssignment.count({ where: { orgId: org.id, staffUserId: user.id, role: { key: 'owner' }, revokedAt: null } }),
  ).toBe(1)

  // Used once; the same link now reads as any dead one.
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'That invitation cannot be used' })).toBeVisible()
})
