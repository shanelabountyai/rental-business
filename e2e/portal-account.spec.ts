import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// R-164: `/portal/account` - the tenant's own say over how they are
// contacted and billed, plus the staff mirror for the counter.
//
// ==========================================================================
// WHY THIS FILE EXISTS AT ALL.
//
// Every piece here reuses tested core logic (switchDecision, consentVerdict,
// isLockedCategory) that already had a caller for a STAFF actor. What none
// of it had was a tenant-scoped derivation - `setOwnNotificationPreference`,
// `withdrawOwnConsent` and `turnOffAutopay` are new authorization boundaries,
// not new business rules, and an authorization boundary is exactly the kind
// of thing that is correct in isolation and wrong the moment two tenants
// exist (see portal.spec.ts's own header for the same argument about
// documents).
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function seedTenancy(options: {
  withEmail?: boolean
  withSubscription?: boolean
  autopayOn?: boolean
} = {}) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Account LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Account House-${stamp}`,
      addressLine1: '9 Preference Court',
      city: 'Austin',
      state: 'TX',
      postalCode: '78704',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Sasha',
      lastName: `Account-${stamp}`,
      email: options.withEmail === false ? null : `sasha-${stamp}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 175_000,
      rentDueDay: 1,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  // NO CHARGES - the same reasoning collection-method.spec.ts's seed gives:
  // the billing provider answers "what is still owed" against the ledger, so
  // a lease with nothing outstanding is what keeps the open-invoice refusal
  // from firing.
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      collectionMethod: 'charge_automatically',
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      stripeSubscriptionId: options.withSubscription
        ? `sub_${randomUUID().replace(/-/g, '').slice(0, 14)}`
        : null,
      // `paymentView`'s `autopayOn` needs BOTH `charge_automatically` and a
      // saved method - see its own comment on why a saved card alone is not
      // autopay and automatic billing with no method is not either.
      defaultPaymentMethodId: options.autopayOn ? `pm_${randomUUID().replace(/-/g, '')}` : null,
    },
  })
  return { property, lease, tenant, payer }
}

async function seedConsent(
  tenantId: string,
  overrides: { channel?: 'SMS' | 'EMAIL' | 'VOICE'; revoked?: boolean } = {},
) {
  return prisma.tenantConsent.create({
    data: {
      tenantId,
      channel: overrides.channel ?? 'SMS',
      basis: 'EXISTING_RELATIONSHIP',
      source: 'STAFF_RECORDED',
      ...(overrides.revoked
        ? { revokedAt: new Date(), revokeReason: 'Seeded already withdrawn' }
        : {}),
    },
  })
}

/// Mints a magic link the way the sign-in action would, without needing
/// email. Mirrors e2e/portal.spec.ts's identical helper.
async function magicLinkFor(tenantId: string) {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
}

async function seedOwner() {
  const email = `account-staff-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Counter Staff',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function signInStaff(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // TenantConsent is append-only (COMM-02's trigger); Tenant, Property and
  // LegalEntity are deactivated rather than deleted, the same as every other
  // spec that touches an append-only table.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({
    where: { propertyId: { in: propertyIds } },
    data: { status: 'ENDED' },
  })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test.describe('a tenant’s own notification preferences', () => {
  test('turns a category off and it sticks to the tenant, not the wrong table row', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/account')
    const toggle = page.locator('#pref-rent_reminder-EMAIL')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()

    await expect
      .poll(
        async () =>
          (
            await prisma.notificationPreference.findFirst({
              where: { recipientType: 'TENANT', recipientId: tenant.id, category: 'rent_reminder', channel: 'EMAIL' },
            })
          )?.enabled,
        { timeout: 10_000 },
      )
      .toBe(false)
  })

  test('locks legally-critical categories and explains why, same as staff see', async ({
    page,
  }) => {
    const { tenant } = await seedTenancy()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/account')

    const legal = page.getByRole('listitem').filter({ hasText: 'Legal notices' })
    await expect(legal.getByText('Always on.')).toBeVisible()
    await expect(legal.getByRole('button')).toHaveCount(0)
  })
})

test.describe('a tenant’s own TCPA consent', () => {
  test('sees what is on file and withdraws it', async ({ page }) => {
    const { tenant } = await seedTenancy()
    await seedConsent(tenant.id)
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/account')

    // "Text message" appears in both the record and the withdraw form's own
    // <option> - scope to the record, not a bare substring match.
    await expect(page.getByRole('listitem').filter({ hasText: 'Text message' })).toBeVisible()
    await expect(page.getByText('In effect')).toBeVisible()

    // The only live consent for this tenant, so the select's default
    // (first-and-only option) is already it.
    await expect(page.getByLabel('Withdraw permission to').locator('option')).toHaveCount(1)
    await page.getByLabel('Why you are withdrawing this').fill('Getting too many texts.')
    await page.getByRole('button', { name: 'Withdraw' }).click()

    await expect(page.getByText('Consent withdrawn.')).toBeVisible()
    await expect
      .poll(async () =>
        prisma.tenantConsent
          .findFirst({ where: { tenantId: tenant.id, channel: 'SMS' }, select: { revokedAt: true } })
          .then((row) => row?.revokedAt != null),
      )
      .toBe(true)
  })

  test('never shows a consent that belongs to somebody else', async ({ page }) => {
    // The write side of this boundary (`withdrawOwnConsent`'s
    // `findFirst({ id, tenantId })`) is the same shape `replyFromPortal`
    // already uses with no adversarial browser test - the query makes a
    // foreign id indistinguishable from a missing one by construction, not by
    // a runtime check a crafted request could race or bypass. What a browser
    // actually proves is the READ side: that the menu never OFFERS the id to
    // begin with.
    const { tenant: mine } = await seedTenancy()
    const { tenant: theirs } = await seedTenancy()
    await seedConsent(theirs.id, { channel: 'VOICE' })
    await seedConsent(mine.id, { channel: 'SMS' })

    await page.goto(await magicLinkFor(mine.id))
    await page.goto('/portal/account')

    // Only my own channel is offered - "Phone call" (VOICE) never appears.
    await expect(page.getByText('Phone call')).toHaveCount(0)
    await expect(page.getByLabel('Withdraw permission to').locator('option')).toHaveCount(1)
  })
})

test.describe('a tenant turns autopay off', () => {
  test('switches to invoiced billing through switchDecision, the same ladder staff use', async ({
    page,
  }) => {
    const { tenant, payer } = await seedTenancy({ withSubscription: true, autopayOn: true })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.getByRole('heading', { name: 'Automatic payments are on' })).toBeVisible()
    await page.getByRole('button', { name: 'Turn off automatic payments' }).click()

    await expect(page.getByText('Automatic payments are off.')).toBeVisible()
    await expect
      .poll(
        async () =>
          (await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })).collectionMethod,
        { timeout: 10_000 },
      )
      .toBe('send_invoice')
  })

  test('D-36: refused in a sentence for a payer with no email on file', async ({ page }) => {
    const { tenant, payer } = await seedTenancy({
      withSubscription: true,
      autopayOn: true,
      withEmail: false,
    })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await page.getByRole('button', { name: 'Turn off automatic payments' }).click()

    await expect(page.getByText(/Invoiced billing needs an email address/)).toBeVisible()
    const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
    expect(after.collectionMethod).toBe('charge_automatically')
  })
})

test.describe('the staff mirror for the counter', () => {
  test('staff change a tenant’s notification preference from the lease page', async ({ page }) => {
    const { lease, tenant } = await seedTenancy()
    const staff = await seedOwner()
    await signInStaff(page, staff.email)
    await page.goto(`/leases/${lease.id}`)

    await expect(page.locator(`#notifications-${tenant.id}`)).toHaveText(/Notifications — Sasha/)

    const toggle = page.locator(`#pref-${tenant.id}-rent_reminder-EMAIL`)
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()

    await expect
      .poll(
        async () =>
          (
            await prisma.notificationPreference.findFirst({
              where: { recipientType: 'TENANT', recipientId: tenant.id, category: 'rent_reminder', channel: 'EMAIL' },
            })
          )?.enabled,
        { timeout: 10_000 },
      )
      .toBe(false)
  })
})

test.describe('accessibility', () => {
  test('the tenant account page has no detectable violations', async ({ page }) => {
    const { tenant } = await seedTenancy()
    await seedConsent(tenant.id)
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/account')

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
