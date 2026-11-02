import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { type Page, expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, PASSWORD, code, createAdmin, ensureKeeperOwner, retireAdmins, signIn } from './platform-fixtures.ts'

// R-295a (PRD 11 §4.7, §4.14, §4.16): the grant lifecycle end to end. The
// admin asks on the console; the org's owner answers on the org's own host.
// Entering the org under a grant is R-295b's, so nothing here enters.

const PORT = process.env.PORT ?? '3100'
const admins: string[] = []
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
  await retireAdmins(admins)
})

/// An org with one property and one MFA-enrolled owner (`staff.manage` is
/// privileged, so answering needs a second factor at sign-in, ROLE-05).
async function orgWithOwner(tag: string) {
  const slug = `e2e-support-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `Support Org ${tag}` } })
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: `Entity ${tag}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      orgId: org.id,
      legalEntityId: entity.id,
      name: `Support House ${tag}`,
      addressLine1: '1 Support Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const email = `support-owner-${tag}@example.test`
  const { secret } = createTotpEnrolment(email)
  const owner = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: org.id } },
      email,
      name: 'Support Owner',
      credential: {
        create: { passwordHash: await hashPassword(PASSWORD), mfaSecret: sealSecret(secret), mfaEnrolledAt: new Date() },
      },
    },
  })
  staffIds.push(owner.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: owner.id, roleId: role.id, orgId: org.id } })
  return { org, host: `http://${slug}.orgs.localhost:${PORT}`, owner: { ...owner, secret } }
}

async function ownerSignsIn(page: Page, host: string, owner: { email: string; secret: string }) {
  await page.goto(`${host}/login`)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page.getByLabel(/code/i).fill(code(owner.secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  // Auth.js sends the browser to AUTH_URL's host (bare localhost, org #0;
  // R-276, D-379), which has no session and bounces to its own /login. The
  // cookie is the org host's all the same, so wait only to leave this host's
  // MFA page.
  const orgHost = new URL(host).hostname
  await page.waitForURL((url) => url.hostname !== orgHost)
}

test('a request waits for an owner, who approves it on the org host for less than was asked', async ({ page, browser }, testInfo) => {
  await ensureKeeperOwner()
  const admin = await createAdmin(true, admins, ['platform_support'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const { org, host, owner } = await orgWithOwner(tag)

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${org.slug}/support`)
  await axeScan(page)
  await page.getByLabel('Reason for the request').fill('A tenant says their March payment is missing from the ledger.')
  await page.getByRole('button', { name: 'Request access' }).click()
  await expect(page.getByText(/^Requested\. 1 owner was told\./)).toBeVisible()
  const grant = await prisma.supportAccessGrant.findFirstOrThrow({ where: { orgId: org.id, platformAdminId: admin.id } })
  expect(grant).toMatchObject({ kind: 'REQUESTED', requestedMinutes: 240, approvedAt: null })
  expect(await prisma.task.count({ where: { type: 'support_access_requested', subjectId: grant.id } })).toBe(1)
  expect(await prisma.auditLog.count({ where: { action: 'support_grant.requested', supportGrantId: grant.id, actorType: 'PLATFORM' } })).toBe(1)

  const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  try {
    const ownerPage = await context.newPage()
    await ownerSignsIn(ownerPage, host, owner)
    await ownerPage.goto(`${host}/settings/support-access`)
    await expect(ownerPage.getByRole('heading', { name: 'Waiting for an answer' })).toBeVisible()
    await axeScan(ownerPage)
    await ownerPage.getByLabel(`Duration for ${admin.name}`).selectOption('60')
    await ownerPage.getByLabel(`Your authenticator code to approve ${admin.name}`).fill(code(owner.secret))
    await ownerPage.getByRole('button', { name: `Approve request from ${admin.name}` }).click()
    await expect(ownerPage.getByText(`${admin.name} has read-only access for 1 hour.`)).toBeVisible()
    await expect(ownerPage.getByRole('button', { name: `Revoke access for ${admin.name} now` })).toBeVisible()

    const approved = await prisma.supportAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })
    expect(approved.approvedByStaffId).toBe(owner.id)
    expect(approved.expiresAt!.getTime() - approved.startsAt!.getTime()).toBe(60 * 60_000)
    expect(await prisma.task.count({ where: { subjectId: grant.id, status: 'DONE' } })).toBe(1)
  } finally {
    await context.close()
  }
})

test('break-glass notifies the owner at once and stays on the dashboard until it is marked seen', async ({ page, browser }, testInfo) => {
  await ensureKeeperOwner()
  const admin = await createAdmin(true, admins, ['platform_support'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const { org, host, owner } = await orgWithOwner(tag)

  // A fresh sign-in just proved a code, so break-glass's step-up is fresh.
  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${org.slug}/support`)
  await page.getByLabel('Reason for emergency access').fill('Rent webhooks are failing for every lease tonight.')
  await page.getByRole('button', { name: 'Open emergency access' }).click()
  await expect(page.getByText(/^Emergency access is open for 60 minutes\. 1 owner was told\./)).toBeVisible()

  const grant = await prisma.supportAccessGrant.findFirstOrThrow({ where: { orgId: org.id, kind: 'BREAK_GLASS' } })
  const notices = await prisma.notification.findMany({
    where: { category: 'support_access', recipientId: owner.id, idempotencyKey: { startsWith: `support-grant:${grant.id}:` } },
    select: { channel: true, orgId: true },
  })
  expect(notices.map((n) => n.channel)).toContain('EMAIL')
  expect(new Set(notices.map((n) => n.orgId))).toEqual(new Set([org.id]))

  const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  try {
    const ownerPage = await context.newPage()
    await ownerSignsIn(ownerPage, host, owner)
    await ownerPage.goto(`${host}/dashboard`)
    const banner = ownerPage.getByRole('complementary', { name: `Emergency access by ${admin.name}`, exact: false })
    await expect(banner).toBeVisible()
    await axeScan(ownerPage)
    await ownerPage.getByRole('button', { name: `Mark emergency access by ${admin.name} as seen` }).click()
    await expect(ownerPage.getByText('Marked as seen for every owner.')).toBeVisible()
    await expect(banner).toHaveCount(0)
    expect((await prisma.supportAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).acknowledgedByStaffId).toBe(owner.id)
  } finally {
    await context.close()
  }
})
