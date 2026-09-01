import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { axeScan, uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// TCPA consent, recorded by a person (COMM-02, R-051b, wired R-143).
//
// ==========================================================================
// WHY THIS FILE EXISTS AT ALL.
//
// R-051b built `recordConsent` and `withdrawConsent`, the CHECK constraint,
// the append-only trigger and `consentVerdict`, and `send.ts` has refused
// every tenant SMS without a consent row ever since. Nothing called either
// action - not a page, not a test. `consent.test.ts` proves the send path by
// writing the row with `prisma.tenantConsent.create`, which is why the gap
// stayed invisible: the rule worked perfectly against a row that could only
// ever exist in a fixture. In a deployed environment no tenant could receive
// a text, and no screen anywhere could change that.
//
// So what only a browser proves here is the whole of it: that a member of
// staff can create the row the send path reads, and take it back.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Consent LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Consent House-${stamp}`,
      addressLine1: '18 Disclosure Lane',
      city: 'Austin',
      state: 'TX',
      postalCode: '78702',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  // `uniquePhone()`, never a literal: a crashed run leaving a live tenant on
  // a hard-coded number is what makes inbound SMS routing refuse to guess.
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Dana', lastName: `Consenting-${stamp}`, phone: uniquePhone() },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 180_000,
      rentDueDay: 1,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { property, unit, lease, tenant }
}

/// PORTFOLIO-WIDE and MFA-enrolled. The panel is gated on `tenant.write`
/// rather than the `lease.write` its neighbours use, so an owner is the
/// simplest actor that certainly holds it.
async function seedOwner() {
  const email = `consent-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Consent Owner',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, secret }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // Scoped by ownership, not by a collected-id list, and nothing is deleted:
  // `TenantConsent` is append-only except for its one withdrawal, and every
  // action here writes an audit row that points at the property.
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

test('THE GAP R-143 CLOSED: a person can create the consent row the send path reads', async ({
  page,
}) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  // Said before anything is recorded: the panel's whole job is to explain why
  // a tenant with no row here never gets a text.
  await expect(page.getByRole('heading', { name: 'Permission to contact' })).toBeVisible()
  await expect(page.getByText(/Nobody on this lease has agreed to be contacted yet/)).toBeVisible()

  await page.getByLabel('Which tenant agreed').selectOption(tenant.id)
  await page.getByLabel('What they agreed to be contacted on').selectOption('SMS')
  await page
    .getByLabel('How that consent was obtained')
    .selectOption('EXISTING_RELATIONSHIP')
  await page.getByLabel('Note about how this consent was captured').fill('Gave the number at signing.')
  await page.getByRole('button', { name: 'Record this consent' }).click()

  // Poll the FACT, not a UI signal: every visible signal on this page - the
  // button's own label included - resolves before the write lands.
  await expect
    .poll(async () =>
      prisma.tenantConsent.count({ where: { tenantId: tenant.id, revokedAt: null } }),
    )
    .toBe(1)

  const row = await prisma.tenantConsent.findFirstOrThrow({ where: { tenantId: tenant.id } })
  expect(row.channel).toBe('SMS')
  expect(row.basis).toBe('EXISTING_RELATIONSHIP')
  // STAFF_RECORDED, and the staff id with it: a TCPA claim turns on who
  // asserted the tenant agreed, not merely that somebody did.
  expect(row.source).toBe('STAFF_RECORDED')
  expect(row.recordedByStaffId).toBe(staff.id)

  // And the audit trail carries it, which is the half no screen shows.
  const audits = await prisma.auditLog.count({
    where: { action: 'consent.recorded', entityId: tenant.id },
  })
  expect(audits).toBe(1)
})

test('express written consent is refused without the wording that was shown', async ({ page }) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Which tenant agreed').selectOption(tenant.id)
  await page.getByLabel('What they agreed to be contacted on').selectOption('SMS')
  await page.getByLabel('How that consent was obtained').selectOption('EXPRESS_WRITTEN')
  await page.getByRole('button', { name: 'Record this consent' }).click()

  // `getByText`, never `getByRole('alert')`: Next's route announcer is itself
  // a role="alert" and matches first on every page.
  await expect(
    page.getByText(/Express written consent needs the wording the tenant agreed to/),
  ).toBeVisible()
  expect(await prisma.tenantConsent.count({ where: { tenantId: tenant.id } })).toBe(0)
})

test('withdrawing needs a reason, and the record survives the withdrawal', async ({ page }) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()
  const consent = await prisma.tenantConsent.create({
    data: {
      tenantId: tenant.id,
      channel: 'SMS',
      basis: 'VERBAL',
      source: 'STAFF_RECORDED',
      note: 'Agreed on the move-in call.',
    },
  })

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)
  await expect(page.getByText('Consent in effect')).toBeVisible()

  await page.getByLabel('Which consent is being withdrawn').selectOption(consent.id)
  await page.getByLabel('Why the consent is being withdrawn').fill('They asked us to stop texting.')
  await page.getByRole('button', { name: 'Withdraw this consent' }).click()

  await expect
    .poll(async () =>
      prisma.tenantConsent.count({ where: { tenantId: tenant.id, revokedAt: { not: null } } }),
    )
    .toBe(1)

  // The row is still there and still says what it said. Withdrawal is the one
  // permitted UPDATE; the basis and the note are evidence and the trigger
  // refuses to let either change.
  const after = await prisma.tenantConsent.findUniqueOrThrow({ where: { id: consent.id } })
  expect(after.basis).toBe('VERBAL')
  expect(after.note).toBe('Agreed on the move-in call.')
  expect(after.revokeReason).toBe('They asked us to stop texting.')
})

test('the panel has no accessibility violations', async ({ page }) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()
  await prisma.tenantConsent.create({
    data: {
      tenantId: tenant.id,
      channel: 'SMS',
      basis: 'VERBAL',
      source: 'STAFF_RECORDED',
    },
  })

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)
  await expect(page.getByRole('heading', { name: 'Permission to contact' })).toBeVisible()

  const results = await axeScan(page)
  expect(results.violations).toEqual([])
})
