import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { type Browser, type TestInfo, expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders, uniquePhone, uniqueStateCode } from './fixtures.ts'
import { CONSOLE, PASSWORD, code, createAdmin, ensureKeeperOwner, retireAdmins, signIn } from './platform-fixtures.ts'

// R-291a (PRD 10 §5): the provisioning checklist. The owner sees it from the
// dashboard of a PROVISIONING org and states "just me"; the console reads the
// refreshed booleans, and "Go live" refuses while any step is open, naming it.
// R-291b: step 9's two presses make the last facts, so the second test walks
// every step to a successful go-live.

const PORT = process.env.PORT ?? '3100'
const admins: string[] = []
const staffIds: string[] = []
const propertyIds: string[] = []
const ruleIds: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: staffIds } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await retireAdmins(admins)
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
})

/// A PROVISIONING org with an entity, one property in `state`, and one owner
/// enrolled in MFA, signed in on the org's host in a new context.
async function provisioningOrg(browser: Browser, testInfo: TestInfo, state = 'TX') {
  await ensureKeeperOwner()
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-setup-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `Setup Org ${tag}` } })
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: `Entity ${tag}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      orgId: org.id,
      legalEntityId: entity.id,
      name: `Setup House ${tag}`,
      addressLine1: '1 Setup Way',
      city: 'Houston',
      state,
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
  const ownerPage = await context.newPage()
  await ownerPage.goto(`${host}/login`)
  await ownerPage.getByLabel('Email').fill(email)
  await ownerPage.getByLabel('Password').fill(PASSWORD)
  await ownerPage.getByRole('button', { name: 'Sign in' }).click()
  await ownerPage.waitForURL(/\/login\/mfa/)
  await ownerPage.getByLabel(/code/i).fill(code(secret))
  await ownerPage.getByRole('button', { name: 'Verify' }).click()
  await ownerPage.waitForURL(`${host}/dashboard`)
  return { org, slug, host, owner, context, ownerPage }
}

test('an owner works the checklist and the console refuses go-live until every step is done', async ({ page, browser }, testInfo) => {
  const { org, slug, context, ownerPage } = await provisioningOrg(browser, testInfo)
  expect(org.status).toBe('PROVISIONING')
  try {
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

test('the owner makes step 9 with a test text and a paid $1, and the console marks the org live', async ({ page, browser }, testInfo) => {
  // Step 8 needs a counsel-reviewed rule in force, which the seeded Texas
  // placeholder is not (OQ-6), so this org's property is in its own state.
  const state = uniqueStateCode()
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 3,
      lateFeeType: 'NONE',
      entryNoticeHours: 24,
      paymentAllocationOrder: ['RENT'],
      reviewedBy: 'E2E Counsel',
    },
  })
  ruleIds.push(rule.id)
  const { org, slug, host, owner, context, ownerPage } = await provisioningOrg(browser, testInfo, state)
  // R-298a: and the org's own counsel review of it (D-389).
  await prisma.orgJurisdiction.create({
    data: { orgId: org.id, state, counselReviewedBy: 'E2E Counsel', counselReviewedAt: new Date('2026-01-02') },
  })
  // R-297: step 8 also needs the org's own criteria and one reason on a criterion.
  await prisma.screeningCriteria.create({
    data: { orgId: org.id, version: 1, incomeToRentMultiplierX100: 300, evictionLookbackMonths: 84, criminalLookbackMonths: 84 },
  })
  await prisma.decisionReason.create({
    data: { orgId: org.id, code: 'INCOME_BELOW_CRITERIA', label: 'Income below the written screening criteria', criterion: 'income' },
  })
  // Steps 5 and 6 are the providers' to finish; their onboarding has its own specs.
  await prisma.orgIntegration.createMany({
    data: [
      { orgId: org.id, provider: 'STRIPE', status: 'ENABLED', config: { provisionedBy: 'simulated', accountId: `acct_sim${org.id}` } },
      { orgId: org.id, provider: 'TWILIO', status: 'ACTIVE', config: { provisionedBy: 'simulated', campaignStatus: 'APPROVED' } },
    ],
  })
  await prisma.organization.update({ where: { id: org.id }, data: { setupMarks: ['just_me', 'templates_reviewed', 'shared_email'] } })

  try {
    await ownerPage.goto(`${host}/settings/setup`)
    const step = ownerPage.getByRole('listitem').filter({ hasText: 'Test text and test payment' })
    await expect(step).toContainText(/test payment: not done/)
    await axeScan(ownerPage)

    const phone = uniquePhone()
    await ownerPage.getByLabel('Your mobile number').fill(phone)
    await ownerPage.getByRole('button', { name: 'Send a test text' }).click()
    await expect(ownerPage.getByText(/^Test text sent to .*once the carrier reports it delivered\.$/)).toBeVisible()
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { orgId: org.id, notification: { templateKey: 'setup.test_text', recipientId: owner.id } },
    })
    expect(delivery.status).toBe('SENT')
    // The logging adapter never hears back from a carrier, so the delivery is
    // written the way a Twilio status callback (/api/sms/status) writes it.
    await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } })

    await ownerPage.getByRole('button', { name: 'Bill me $1' }).click()
    await ownerPage.waitForURL(/\/settings\/setup\/simulated-invoice\/in_simsetup/)
    await expect(ownerPage.getByRole('heading', { name: 'Simulated Stripe invoice' })).toBeVisible()
    await ownerPage.getByRole('button', { name: 'Pay $1.00' }).click()
    await ownerPage.waitForURL(/\/settings\/setup$/)
    await expect(step).toContainText(/test payment: done/)
    // Done, so the presses are gone.
    await expect(ownerPage.getByRole('button', { name: 'Bill me $1' })).toHaveCount(0)
    expect(await prisma.setupTestPayment.count({ where: { orgId: org.id, amountCents: 100 } })).toBe(1)
    expect(await prisma.ledgerEntry.count({ where: { orgId: org.id } })).toBe(0)
    expect(
      await prisma.auditLog.count({ where: { orgId: org.id, action: { in: ['org.test_text_sent', 'org.test_invoice_sent'] } } }),
    ).toBe(2)
  } finally {
    await context.close()
  }

  const admin = await createAdmin(true, admins, ['platform_owner'])
  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)
  await page.getByLabel('Type the slug to confirm going live').fill(slug)
  await page.getByRole('button', { name: 'Mark the organisation live' }).click()
  await expect(page.getByText('The organisation is live. Its slug is now fixed.')).toBeVisible()
  expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe('ACTIVE')
  expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'org.went_live' } })).toBe(1)
})
