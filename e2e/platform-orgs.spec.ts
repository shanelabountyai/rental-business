import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'
import { CONSOLE, createAdmin, retireAdmins, signIn } from './platform-fixtures.ts'

// The org console's read side (PRD 11 §4.2–4.4, R-303). The org is this
// spec's own, so its health and integration rows are not raced by a cron
// another spec triggers against org #0. PLAT-03 (what these pages may read)
// is proved by the query spy in tests/invariants/plat-02-03.test.ts.

const admins: string[] = []
const tag = randomUUID().slice(0, 8)
const org = { id: `org_e2e_${tag}`, slug: `e2e-console-${tag}`, name: `Console Spec Org ${tag}` }
const ownerEmail = `console-owner-${tag}@example.test`
const ownerPhone = uniquePhone()

// The stale-health test rewrites this org's row, so the file runs in order.
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await prisma.organization.create({ data: org })
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffUser.create({
    data: {
      email: ownerEmail,
      name: `Owner ${tag}`,
      phone: ownerPhone,
      orgMemberships: { create: { orgId: org.id } },
      assignments: { create: { orgId: org.id, roleId: ownerRole.id } },
    },
  })
  await prisma.orgIntegration.create({
    data: { orgId: org.id, provider: 'TWILIO', status: 'FAILED', statusReason: 'Campaign rejected: sample message missing' },
  })
  const now = new Date()
  await prisma.orgHealth.create({
    data: {
      orgId: org.id,
      computedAt: now,
      dailyAt: now,
      dailyOk: false,
      failedRuns7d: 2,
      deadLetters: 1,
      queuedNotifications: 0,
      heldNotifications: 0,
      activeOwners: 1,
      activeMembers: 1,
      properties: 0,
      states: [],
    },
  })
})

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await retireAdmins(admins)
  await prisma.staffAssignment.deleteMany({ where: { orgId: org.id } })
  await prisma.staffUser.deleteMany({ where: { email: ownerEmail } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: org.id } })
  await prisma.orgHealth.deleteMany({ where: { orgId: org.id } })
  await prisma.organization.deleteMany({ where: { id: org.id } })
})

test('a viewer finds an org that needs attention and sees only what the platform may know', async ({ page }) => {
  const viewer = await createAdmin(true, admins, ['platform_viewer'])
  await signIn(page, viewer)

  const attention = page.getByRole('region', { name: 'Needs attention' })
  const row = attention.getByRole('listitem').filter({ hasText: org.name })
  await expect(row).toContainText('Last daily run failed · 1 dead-lettered event · Twilio failed')

  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Organisations' }).click()
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible()
  await page.getByLabel('Search by name or slug').fill(org.slug.toUpperCase())
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('link', { name: org.name }).click()

  await expect(page.getByRole('heading', { name: org.name })).toBeVisible()
  await expect(page.getByText('Viewing inside this organisation needs a support grant.')).toBeVisible()
  const owners = page.getByRole('region', { name: 'Owners' })
  await expect(owners).toContainText(`Owner ${tag}`)
  await expect(owners).toContainText(ownerEmail)
  // D-354: name and email, never anything else about the person.
  await expect(page.getByText(ownerPhone)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Integrations' })).toContainText('Campaign rejected: sample message missing')
  const health = page.getByRole('region', { name: 'Health' })
  await expect(health).toContainText(/Daily run\s*failed/)
  await expect(health).toContainText(/Failed runs, last 7 days\s*2/)

  await page.goto(`${CONSOLE}/platform/orgs?q=no-such-org-${tag}`)
  await expect(page.getByText('No organisations match.')).toBeVisible()
})

test('stale health reads as not reported, never as its old numbers', async ({ page }) => {
  await prisma.orgHealth.update({ where: { orgId: org.id }, data: { computedAt: new Date(Date.now() - 27 * 3_600_000) } })
  const viewer = await createAdmin(true, admins, ['platform_viewer'])
  await signIn(page, viewer)
  await page.goto(`${CONSOLE}/platform/orgs/${org.slug}`)
  const health = page.getByRole('region', { name: 'Health' })
  await expect(health).toContainText('Health not reported since')
  await expect(health.getByText('Failed runs, last 7 days')).toHaveCount(0)
})

test('an admin without org.read gets the console but not the organisations', async ({ page }) => {
  const bare = await createAdmin(true, admins)
  await signIn(page, bare)
  await expect(page.getByRole('region', { name: 'Needs attention' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Organisations' })).toHaveCount(0)
  await page.goto(`${CONSOLE}/platform/orgs/${org.slug}`)
  await expect(page.getByText('It needs the org.read permission')).toBeVisible()
})
