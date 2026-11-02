import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, PASSWORD, code, createAdmin, ensureKeeperOwner, retireAdmins, signIn } from './platform-fixtures.ts'

// R-291a (PRD 10 §5): the provisioning checklist. The owner sees it from the
// dashboard of a PROVISIONING org and states "just me"; the console reads the
// refreshed booleans, and "Go live" refuses while any step is open, naming it.
// The success path needs every fact (a delivered text, a projected payment),
// which R-291b's test actions make; `readyToGoLive` is unit-tested.

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
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await retireAdmins(admins)
})

test('an owner works the checklist and the console refuses go-live until every step is done', async ({ page, browser }, testInfo) => {
  await ensureKeeperOwner()
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-setup-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `Setup Org ${tag}` } })
  expect(org.status).toBe('PROVISIONING')
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: `Entity ${tag}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      orgId: org.id,
      legalEntityId: entity.id,
      name: `Setup House ${tag}`,
      addressLine1: '1 Setup Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const email = `setup-owner-${tag}@example.test`
  const { secret } = createTotpEnrolment(email)
  const owner = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: org.id } },
      email,
      name: 'Setup Owner',
      credential: {
        create: { passwordHash: await hashPassword(PASSWORD), mfaSecret: sealSecret(secret), mfaEnrolledAt: new Date() },
      },
    },
  })
  staffIds.push(owner.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: owner.id, roleId: role.id, orgId: org.id } })
  const host = `http://${slug}.orgs.localhost:${PORT}`

  const context = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  try {
    const ownerPage = await context.newPage()
    await ownerPage.goto(`${host}/login`)
    await ownerPage.getByLabel('Email').fill(email)
    await ownerPage.getByLabel('Password').fill(PASSWORD)
    await ownerPage.getByRole('button', { name: 'Sign in' }).click()
    await ownerPage.waitForURL(/\/login\/mfa/)
    await ownerPage.getByLabel(/code/i).fill(code(secret))
    await ownerPage.getByRole('button', { name: 'Verify' }).click()
    await ownerPage.waitForURL(`${host}/dashboard`)

    await ownerPage.getByRole('link', { name: 'Finish the setup checklist' }).click()
    await expect(ownerPage.getByRole('heading', { name: 'Setup' })).toBeVisible()
    const step = (name: string) => ownerPage.getByRole('listitem').filter({ hasText: name })
    await expect(step('Organisation created, owner invited and accepted')).toContainText(/accepted: done/)
    await expect(step('Users and roles')).toContainText(/Users and roles: not done/)
    // The provider's state, in words, where nothing has started.
    await expect(step('Stripe connected')).toContainText('Stripe is not started.')
    await axeScan(ownerPage)

    await ownerPage.getByRole('button', { name: 'Mark that I run this alone' }).click()
    await expect(ownerPage.getByText('Marked: you run this organisation alone.')).toBeVisible()
    await expect(step('Users and roles')).toContainText(/Users and roles: done/)
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).setupMarks).toEqual(['just_me'])
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'org.setup_marked' } })).toBe(1)
  } finally {
    await context.close()
  }

  // The console reads the booleans the owner's press just refreshed.
  const admin = await createAdmin(true, admins, ['platform_owner'])
  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)
  await expect(page.getByRole('heading', { name: 'Provisioning checklist' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Users and roles' })).toContainText(/Users and roles: done/)

  await page.getByLabel('Type the slug to confirm going live').fill(slug)
  await page.getByRole('button', { name: 'Mark the organisation live' }).click()
  await expect(page.getByText(/^Not every step is done: .*Stripe connected/)).toBeVisible()
  expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe('PROVISIONING')
  expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'org.went_live' } })).toBe(0)

  // Once live, the slug is fixed: the console stops offering the change.
  await prisma.organization.update({ where: { id: org.id }, data: { status: 'ACTIVE' } })
  await page.reload()
  await expect(page.getByText(`${slug} · live`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change slug' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mark the organisation live' })).toHaveCount(0)
})
