import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, createAdmin, retireAdmins, signIn } from './platform-fixtures.ts'

// The console's jobs, audit and settings pages (PRD 11 §4.9, §4.10, §4.12,
// R-303b). The re-run targets this spec's own org and the notification child,
// which takes no claim and dispatches only that org's rows - never org #0,
// whose queue belongs to every other spec.
//
// THE ORG IS NEVER DELETED. The re-run's audit row references it, `AuditLog`
// is append-only and its foreign key is Restrict, so the delete would fail.
// It has no properties and no staff, so nothing else reads it.

const admins: string[] = []
const tag = randomUUID().slice(0, 8)
const org = { id: `org_e2e_${tag}`, slug: `e2e-ops-${tag}`, name: `Ops Spec Org ${tag}` }

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await prisma.organization.create({ data: org })
})

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await retireAdmins(admins)
  await prisma.orgHealth.deleteMany({ where: { orgId: org.id } })
})

test('support re-runs one org’s notification job, and the audit log records it', async ({ page }) => {
  const support = await createAdmin(true, admins, ['platform_support'])
  await signIn(page, support)

  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Jobs' }).click()
  const section = page.getByRole('region', { name: org.name })
  await expect(section).toContainText('Health not yet reported')
  await section.getByRole('button', { name: `Re-run notification run for ${org.name}` }).click()
  await expect(section.getByText('The job ran and succeeded.')).toBeVisible()

  // The child wrote the org's health row in its own context (D-354). A GET,
  // never `reload()`: a press that landed before hydration was a native form
  // POST, and reloading it re-sends the re-run (mobile-chrome, two audit rows).
  await page.goto(`${CONSOLE}/platform/jobs`)
  await expect(section).toContainText(/Notification run:\s*succeeded/)

  await page.goto(`${CONSOLE}/platform/audit?org=${org.slug}`)
  const row = page.getByRole('listitem').filter({ hasText: 'job.child_retriggered' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(support.name)
  await expect(row.getByRole('link', { name: org.name })).toBeVisible()

  const csv = await page.request.get(`${CONSOLE}/platform/audit/export?org=${org.slug}`)
  expect(csv.headers()['content-type']).toContain('text/csv')
  const lines = (await csv.text()).split('\r\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('job.child_retriggered')
  expect(lines[1]).toContain(support.email)
})

test('a viewer sees jobs without Re-run, and settings without a secret', async ({ page }) => {
  const viewer = await createAdmin(true, admins, ['platform_viewer'])
  await signIn(page, viewer)

  await page.goto(`${CONSOLE}/platform/jobs`)
  await expect(page.getByRole('region', { name: org.name })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Re-run/ })).toHaveCount(0)

  await page.goto(`${CONSOLE}/platform/settings`)
  await expect(page.getByRole('heading', { name: 'Platform settings' })).toBeVisible()
  await expect(page.getByText('platform.localhost', { exact: true })).toBeVisible()
  // playwright.config.ts gives the server this CRON_SECRET; the page says only "set".
  const body = await page.locator('main').innerText()
  expect(body).toContain('CRON_SECRET')
  expect(body).not.toContain(process.env.CRON_SECRET || 'test-only-not-a-real-cron-secret')
})

test('an admin without the permissions is refused each page', async ({ page }) => {
  const bare = await createAdmin(true, admins)
  await signIn(page, bare)
  await expect(page.getByRole('link', { name: 'Jobs' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0)
  await page.goto(`${CONSOLE}/platform/audit`)
  await expect(page.getByText('It needs the platformAudit.read permission')).toBeVisible()
  await page.goto(`${CONSOLE}/platform/settings`)
  await expect(page.getByText('It needs the org.read permission')).toBeVisible()
})
