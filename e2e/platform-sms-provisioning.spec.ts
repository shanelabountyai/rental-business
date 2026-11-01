import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, createAdmin, retireAdmins, signIn } from './platform-fixtures.ts'

// SMS provisioning from the console (PRD 10 §3.1, PRD 11 §3.1 / §4.4, R-292b):
// `integration.provision`, held here by `platform_support` and asking for no
// step-up, starts, re-polls and retires an org's simulated Twilio
// provisioning, and the panel shows Twilio's reason verbatim. The org is this
// spec's own; its audit rows are append-only, so it is left switched off, as
// platform-org-configure.spec.ts leaves its orgs.

const admins: string[] = []
const orgs: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  const rows = await prisma.orgIntegration.findMany({ where: { orgId: { in: orgs } }, select: { config: true } })
  const sids = rows.map((r) => (r.config as Record<string, string>).accountSid).filter(Boolean)
  await prisma.simulatedTwilioAccount.deleteMany({ where: { accountSid: { in: sids } } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: { in: orgs } } })
  await prisma.organization.updateMany({ where: { id: { in: orgs } }, data: { notificationsEnabled: false } })
  await retireAdmins(admins)
})

test('support starts SMS provisioning, re-polls it, sees the reason verbatim, and retires it', async ({ page }, testInfo) => {
  const admin = await createAdmin(true, admins, ['platform_support'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-sms-${tag}`
  const org = await prisma.organization.create({ data: { name: `SMS ${tag}`, slug } })
  orgs.push(org.id)

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)
  const panel = page.getByRole('region', { name: 'Integrations' })
  await expect(panel).toContainText('Not started.')

  await page.getByLabel('Area code for the texting number').fill('123')
  await page.getByRole('button', { name: 'Start SMS provisioning' }).click()
  await expect(page.getByText('Three digits, not starting with 0 or 1.')).toBeVisible()

  await page.getByLabel('Area code for the texting number').fill('737')
  await page.getByRole('button', { name: 'Start SMS provisioning' }).click()
  await expect(page.getByText(/^SMS provisioning started on \+1737\d{7}\./)).toBeVisible()
  await expect(panel).toContainText(/Brand\s*pending/)
  await expect(panel).toContainText(/Campaign\s*not registered yet/)
  await expect(panel).toContainText(/Started\s*today/)

  await page.getByRole('button', { name: 'Re-poll Twilio' }).click()
  await expect(page.getByText('Re-polled. Brand in review, campaign not registered yet.')).toBeVisible()

  // Twilio's own words, forced through the simulator's test seam.
  const reason = `Brand vetting failed: legal name ${tag} does not match the EIN (30794)`
  const row = await prisma.orgIntegration.findUniqueOrThrow({ where: { orgId_provider: { orgId: org.id, provider: 'TWILIO' } } })
  const { accountSid } = row.config as Record<string, string>
  await prisma.simulatedTwilioAccount.update({ where: { accountSid: accountSid! }, data: { failBrandWith: reason } })
  await page.getByRole('button', { name: 'Re-poll Twilio' }).click()
  await expect(page.getByText('Re-polled. Brand failed, campaign not registered yet.')).toBeVisible()
  // Verbatim twice: the row's status line and the brand step that failed.
  await expect(panel.getByText(`failed · ${reason}`, { exact: true })).toHaveCount(2)
  // A provider's sentence is a data value: it must wrap, not widen a phone's page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  // A failed provisioning stops polling and may be started again.
  await expect(page.getByRole('button', { name: 'Re-poll Twilio' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start SMS provisioning' })).toBeVisible()

  await page.getByRole('button', { name: 'Retire SMS' }).click()
  await expect(page.getByText(/^SMS retired\./)).toBeVisible()
  await expect(panel.getByText('retired', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retire SMS' })).toHaveCount(0)

  const audits = await prisma.auditLog.findMany({
    where: { orgId: org.id, action: { startsWith: 'integration.' } },
    orderBy: { occurredAt: 'asc' },
    select: { action: true, actorType: true, before: true, after: true },
  })
  expect(audits.map((a) => a.action)).toEqual([
    'integration.provision_started',
    'integration.polled',
    'integration.polled',
    'integration.retired',
  ])
  expect(audits.every((a) => a.actorType === 'PLATFORM')).toBe(true)
  // Never the sealed subaccount token, in any form.
  expect(JSON.stringify(audits)).not.toContain(row.secret!)
  expect(JSON.stringify(audits)).not.toMatch(/secret|authToken/i)
})
