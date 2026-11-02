import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, PASSWORD, createAdmin, retireAdmins, signIn } from './platform-fixtures.ts'

// R-276 (PRD 10 §4): support adds an org's custom domain on the simulated
// Vercel, verifies it, and the org's owner then signs in ON that domain and
// stays there. Sign-in used to land on AUTH_URL's host (D-379), and a server
// action's `redirect()` is exercised on the same host. `*.localhost` resolves
// to loopback in Chromium, and is outside ORG_BASE_DOMAIN (`orgs.localhost`),
// so it stands in for a domain the org owns.

const PORT = process.env.PORT ?? '3100'
const admins: string[] = []
const orgs: string[] = []
const staffIds: string[] = []
const propertyIds: string[] = []
const domains: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.simulatedVercelDomain.deleteMany({ where: { name: { in: domains } } })
  await prisma.organization.updateMany({ where: { id: { in: orgs } }, data: { customDomain: null, notificationsEnabled: false } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: { in: orgs } } })
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: staffIds } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await retireAdmins(admins)
})

test('a verified custom domain serves its org: the owner signs in on it, stays on it, and loses it on retire', async ({
  page,
  browser,
}, testInfo) => {
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-domain-${tag}`
  const domain = `portal-${tag}.localhost`
  domains.push(domain)
  const custom = `http://${domain}:${PORT}`
  const org = await prisma.organization.create({ data: { slug, name: `Domain Org ${tag}` } })
  orgs.push(org.id)
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: `Entity ${tag}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      orgId: org.id,
      legalEntityId: entity.id,
      name: `Domain House ${tag}`,
      addressLine1: '1 Domain Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const email = `domain-owner-${tag}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: org.id } },
      email,
      name: 'Domain Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id, orgId: org.id } })

  // The console: add, see the records, verify.
  const admin = await createAdmin(true, admins, ['platform_support'])
  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)
  const panel = page.getByRole('region', { name: 'Integrations' })
  await expect(panel).toContainText(`${slug}.orgs.localhost:${PORT}`)

  await page.getByLabel('Custom domain *').fill(`x.${slug}.orgs.localhost`)
  await page.getByRole('button', { name: 'Start custom domain setup' }).click()
  await expect(page.getByText('Hosts under orgs.localhost are organisation subdomains already.')).toBeVisible()

  await page.getByLabel('Custom domain *').fill(domain)
  await page.getByRole('button', { name: 'Start custom domain setup' }).click()
  await expect(page.getByText(`Domain ${domain} added. Publish the DNS records below, then re-poll.`)).toBeVisible()
  const records = page.getByRole('list', { name: 'DNS records' })
  await expect(records.getByRole('listitem')).toHaveCount(2)
  await expect(records).toContainText('cname.vercel-dns.com')
  await expect(records).toContainText(`_vercel.${domain}`)
  await axeScan(page)

  await page.getByRole('button', { name: 'Re-poll Vercel' }).click()
  await expect(page.getByText(`Re-polled. ${domain} is verified and now serves this organisation.`)).toBeVisible()
  await expect(panel).toContainText(`${domain}:${PORT}`)

  // The owner, on the custom domain, in a browser of their own.
  const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  try {
    const owner = await context.newPage()
    await owner.goto(`${custom}/login`)
    await owner.getByLabel('Email').fill(email)
    await owner.getByLabel('Password').fill(PASSWORD)
    await owner.getByRole('button', { name: 'Sign in' }).click()
    // D-379: this used to be AUTH_URL's host, with no session there.
    await owner.waitForURL(`${custom}/dashboard`)

    // A server action that calls `redirect()`, on the same host.
    await owner.goto(`${custom}/tasks/new`)
    await owner.getByLabel('Property *').selectOption(property.id)
    await owner.getByLabel('Title').fill(`Domain task ${tag}`)
    await owner.getByLabel('Priority').selectOption('ROUTINE')
    await owner.getByRole('button', { name: 'Add task' }).click()
    await owner.waitForURL((url) => url.host === `${domain}:${PORT}` && /^\/tasks\/(?!new$)[^/]+$/.test(url.pathname))
    await expect(owner.getByRole('heading', { name: `Domain task ${tag}` })).toBeVisible()

    // Retire: the host names no org any more, so the session on it dies.
    await page.getByRole('button', { name: 'Retire custom domain' }).click()
    await expect(page.getByText(/^Custom domain retired\./)).toBeVisible()
    await owner.goto(`${custom}/dashboard`)
    await owner.waitForURL(`${custom}/login**`)
  } finally {
    await context.close()
  }

  const audits = await prisma.auditLog.findMany({
    where: { orgId: org.id, action: { startsWith: 'integration.' } },
    orderBy: { occurredAt: 'asc' },
    select: { action: true, actorType: true },
  })
  expect(audits.map((a) => a.action)).toEqual(['integration.provision_started', 'integration.polled', 'integration.retired'])
  expect(audits.every((a) => a.actorType === 'PLATFORM')).toBe(true)
})
