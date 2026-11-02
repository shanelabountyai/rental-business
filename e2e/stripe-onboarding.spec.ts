import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// R-277b (PRD 10 §2.2): an org's owner connects its own Stripe account on the
// org's host. The Account Link leads to the simulated hosted onboarding
// (D-27), whose answer comes back as `account.updated` - so the status page
// learns RESTRICTED and then ENABLED the way it would from Stripe.

const PORT = process.env.PORT ?? '3100'
const PASSWORD = 'correct-horse-battery-staple'
const staffIds: string[] = []
const propertyIds: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: staffIds } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
})

test('an owner connects Stripe through onboarding, and collection turns on only once Stripe enables it', async ({
  page,
}, testInfo) => {
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-stripe-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `Stripe Org ${tag}` } })
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: `Entity ${tag}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      orgId: org.id,
      legalEntityId: entity.id,
      name: `Connect House ${tag}`,
      addressLine1: '1 Connect Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const email = `stripe-owner-${tag}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: org.id } },
      email,
      name: 'Stripe Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id, orgId: org.id } })

  const host = `http://${slug}.orgs.localhost:${PORT}`
  await page.goto(`${host}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Auth.js builds its post-sign-in redirect on AUTH_URL (bare localhost, org
  // #0), not the org host - per-domain AUTH_URL is R-276. The session cookie
  // is the org host's all the same, so wait only for the press to land.
  await page.waitForURL((url) => !(url.hostname === `${slug}.orgs.localhost` && url.pathname === '/login'))

  await page.goto(`${host}/money/stripe`)
  await expect(page.getByText('Not connected')).toBeVisible()
  await axeScan(page)
  await page.getByRole('button', { name: 'Connect Stripe' }).click()

  await page.waitForURL(`${host}/money/stripe/simulated/**`)
  await expect(page.getByRole('heading', { name: 'Simulated Stripe onboarding' })).toBeVisible()
  await axeScan(page)
  await page.getByRole('button', { name: 'Submit without a bank account' }).click()

  await expect(page.getByText('Restricted by Stripe')).toBeVisible()
  await expect(page.getByText('requirements.past_due')).toBeVisible()
  await expect(page.getByText('Off. The Stripe account is restricted.')).toBeVisible()

  await page.getByRole('button', { name: 'Continue Stripe onboarding' }).click()
  await page.getByRole('button', { name: 'Finish onboarding' }).click()
  await expect(page.getByText('Connected and collecting')).toBeVisible()
  await expect(page.getByText('On', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Stripe/ })).toHaveCount(0)
})
