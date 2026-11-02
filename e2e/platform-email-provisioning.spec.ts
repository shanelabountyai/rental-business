import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, createAdmin, retireAdmins, signIn } from './platform-fixtures.ts'

// Email domain provisioning from the console (PRD 10 §4, PRD 11 §3.1 / §4.4,
// R-293b): `integration.provision`, held here by `platform_support`, adds an
// org's sending domain on the simulated Resend, shows the DNS records and
// Resend's reason verbatim, starts again after a failure, verifies and
// retires. The org is this spec's own and is left switched off, as
// platform-sms-provisioning.spec.ts leaves its org.

const admins: string[] = []
const orgs: string[] = []
const tags: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  for (const tag of tags) await prisma.simulatedResendDomain.deleteMany({ where: { name: { contains: tag } } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: { in: orgs } } })
  await prisma.organization.updateMany({ where: { id: { in: orgs } }, data: { notificationsEnabled: false } })
  await retireAdmins(admins)
})

test('support adds a sending domain, sees the reason verbatim, starts again, verifies it and retires it', async ({ page }, testInfo) => {
  const admin = await createAdmin(true, admins, ['platform_support'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  tags.push(tag)
  const slug = `e2e-mail-${tag}`
  const domain = `mail.${tag}.example.test`
  const org = await prisma.organization.create({ data: { name: `Mail ${tag}`, slug } })
  orgs.push(org.id)

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)
  const panel = page.getByRole('region', { name: 'Integrations' })
  await expect(panel).toContainText('email goes from the shared address')

  await page.getByLabel('Sending domain').fill('not a domain')
  await page.getByRole('button', { name: 'Start email domain provisioning' }).click()
  await expect(page.getByText('A hostname such as mail.example.com.')).toBeVisible()

  await page.getByLabel('Sending domain').fill(domain)
  await page.getByRole('button', { name: 'Start email domain provisioning' }).click()
  await expect(page.getByText(`Domain ${domain} added. Publish the DNS records below, then re-poll.`)).toBeVisible()
  const records = page.getByRole('list', { name: 'DNS records' })
  await expect(records.getByRole('listitem')).toHaveCount(4)
  await expect(records).toContainText(`resend._domainkey.${domain}`)
  // A DKIM key is one unbreakable token: it must wrap, not widen a phone's page.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Resend's own words, forced through the simulator's test seam.
  const reason = `The DKIM record for ${domain} was not found`
  const row = await prisma.orgIntegration.findUniqueOrThrow({ where: { orgId_provider: { orgId: org.id, provider: 'RESEND' } } })
  const { domainId } = row.config as Record<string, string>
  await prisma.simulatedResendDomain.update({ where: { domainId: domainId! }, data: { failWith: reason } })
  await page.getByRole('button', { name: 'Re-poll Resend' }).click()
  await expect(page.getByText('Re-polled. Domain failed.')).toBeVisible()
  await expect(panel.getByText(`failed · ${reason}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Re-poll Resend' })).toHaveCount(0)

  // Starting again replaces the failed domain, so the same name is accepted.
  await page.getByLabel('Sending domain').fill(domain)
  await page.getByRole('button', { name: 'Start email domain provisioning' }).click()
  await expect(page.getByText(`Domain ${domain} added. Publish the DNS records below, then re-poll.`)).toBeVisible()
  await page.getByRole('button', { name: 'Re-poll Resend' }).click()
  await expect(page.getByText('Re-polled. Domain verified.')).toBeVisible()
  await expect(panel).toContainText(`notifications@${domain}`)
  await expect(panel).toContainText(`reply@${domain}`)
  await expect(records).toHaveCount(0)

  await page.getByRole('button', { name: 'Retire email domain' }).click()
  await expect(page.getByText(/^Email domain retired\./)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retire email domain' })).toHaveCount(0)

  const sealed = (await prisma.orgIntegration.findUniqueOrThrow({ where: { id: row.id } })).secret
  expect(sealed).toBeNull()
  const audits = await prisma.auditLog.findMany({
    where: { orgId: org.id, action: { startsWith: 'integration.' } },
    orderBy: { occurredAt: 'asc' },
    select: { action: true, actorType: true, before: true, after: true },
  })
  expect(audits.map((a) => a.action)).toEqual([
    'integration.provision_started',
    'integration.polled',
    'integration.provision_started',
    'integration.polled',
    'integration.retired',
  ])
  expect(audits.every((a) => a.actorType === 'PLATFORM')).toBe(true)
  // Never the sealed key or inbound secret, in any form.
  expect(JSON.stringify(audits)).not.toContain(row.secret!)
  expect(JSON.stringify(audits)).not.toMatch(/secret|apiKey|re_[0-9a-f]{32}/i)
})
