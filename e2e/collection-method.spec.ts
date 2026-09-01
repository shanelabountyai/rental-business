import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// Moving a payer between autopay and invoiced collection (D-29, R-143).
//
// ==========================================================================
// WHY THIS FILE EXISTS AT ALL.
//
// `switchCollectionMethod` is the decision D-29 is entirely about - the one
// that stops a tenant being billed twice for one month's rent while they move
// between modes. It was built with the Stripe read, the refusal ladder, the
// audit row and the push-before-write ordering, and NOTHING CALLED IT. There
// was no control anywhere in the product, so a payer kept whichever mode they
// were provisioned with for ever: nobody could be put on a payment plan, and
// nobody could be taken off autopay.
//
// `collection.test.ts` proves the ladder as a pure decision. What only a
// browser proves is that a person can reach it - and that a refusal reaches
// them as the sentence rather than as nothing happening.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function seedTenancy(options: { withSubscription: boolean }) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Collection LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Collection House-${stamp}`,
      addressLine1: '44 Autopay Street',
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
  // AN EMAIL, deliberately: `send_invoice` is refused without one, and this
  // file's success case is about the money checks rather than that one.
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Robin',
      lastName: `Payer-${stamp}`,
      email: `robin-${stamp}@example.test`,
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
      rentCents: 200_000,
      rentDueDay: 1,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  // NO CHARGES. The simulated provider answers "what is still owed" from the
  // ledger (D-27), so a lease with nothing outstanding is what makes the
  // open-invoice refusal not fire - which is the point of the success case.
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
    },
  })
  return { property, lease, payer }
}

async function seedOwner() {
  const email = `collection-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Collection Owner',
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

test('THE GAP R-143 CLOSED: a payer can be moved onto invoiced collection', async ({ page }) => {
  const { lease, payer } = await seedTenancy({ withSubscription: true })
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  // The current mode is on the screen before anything is changed - a switch
  // form with nothing saying what they are on today is a guess.
  await expect(page.getByText('Currently: Charged automatically')).toBeVisible()

  await page.getByLabel('Which payer is changing').selectOption(payer.id)
  await page.getByLabel('What they should move to').selectOption('send_invoice')
  await page
    .getByLabel('Why the collection method is changing')
    .fill('Agreed a payment plan after the job loss.')
  await page.getByRole('button', { name: 'Change how this payer is billed' }).click()

  // Poll the fact: the write is what this test is about, and every visible
  // signal on the page resolves before it lands.
  await expect
    .poll(async () =>
      (await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })).collectionMethod,
    )
    .toBe('send_invoice')

  // The reason is on the audit row, which is the half no screen shows and the
  // first thing anybody asks about three months later.
  const entry = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'payment.collection_method_changed', entityId: payer.id },
  })
  expect(entry.reason).toBe('Agreed a payment plan after the job loss.')
})

test('a payer with no subscription is refused, in a sentence', async ({ page }) => {
  const { lease, payer } = await seedTenancy({ withSubscription: false })
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Which payer is changing').selectOption(payer.id)
  await page.getByLabel('What they should move to').selectOption('send_invoice')
  await page.getByLabel('Why the collection method is changing').fill('Moving them to invoices.')
  await page.getByRole('button', { name: 'Change how this payer is billed' }).click()

  // `getByText`, never `getByRole('alert')` — Next's route announcer is itself
  // a role="alert" and matches before any form's own region.
  await expect(page.getByText(/This payer has no subscription yet/)).toBeVisible()
  const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
  expect(after.collectionMethod).toBe('charge_automatically')
})

test('the reason is required — a mode change with no "why" is refused', async ({ page }) => {
  const { lease, payer } = await seedTenancy({ withSubscription: true })
  const staff = await seedOwner()

  await signIn(page, staff)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Which payer is changing').selectOption(payer.id)
  await page.getByLabel('What they should move to').selectOption('send_invoice')
  // The field is `required`, so the browser blocks the submit before the
  // action ever runs. Filling whitespace is what reaches the server guard.
  await page.getByLabel('Why the collection method is changing').fill('   ')
  await page.getByRole('button', { name: 'Change how this payer is billed' }).click()

  await expect(page.getByText('Say why this is changing.')).toBeVisible()
  const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
  expect(after.collectionMethod).toBe('charge_automatically')
})
