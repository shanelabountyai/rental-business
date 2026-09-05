import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { uniqueClientHeaders, uniquePhone } from './fixtures.ts'

// A counter receipt and a printable deposit slip (PAY-05's own two named
// leftovers, R-166).
//
// ==========================================================================
// THIS FILE IS THE FIRST TIME THE OFFLINE-PAYMENT FORM ITSELF HAS BEEN
// CLICKED THROUGH IN A BROWSER. R-038 shipped it with unit coverage on the
// rules (`offline.ts`'s own file) and never an e2e spec of the page, so the
// receipt link this item adds is exercised here alongside the form that
// produces it, rather than in a spec of its own with a second full seed.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seedLeaseWithBalance() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Deposit LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Deposit House-${stamp}`,
      addressLine1: '4 Counter Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
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
      firstName: `Deposit${stamp}`,
      lastName: `Payer-${stamp}`,
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
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      collectionMethod: 'charge_automatically',
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  // The simulated billing provider reports "what is still owed" from the
  // ledger (D-27) - a charge here is what makes the offline form's balance
  // pre-fill nonzero and the record button actually appear on the page.
  await prisma.ledgerEntry.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'CHARGE',
      amountCents: 150_000,
      description: 'September rent',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
    },
  })

  return { entity, property, unit, tenant, lease, stamp }
}

async function seedOwner() {
  const email = `deposits-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Deposits Owner',
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

async function signIn(page: import('@playwright/test').Page, staff: { email: string; secret: string }) {
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

async function assertRealPdf(page: import('@playwright/test').Page, href: string) {
  const response = await page.request.get(href)
  expect(response.status()).toBe(200)
  const bytes = await response.body()
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  return bytes
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  // Payment and Document are not append-only, but LedgerEntry.paymentId and
  // Document's own row both RESTRICT - deposits made by this spec are real
  // rows other tables now point at, so only the roots are deactivated, the
  // same wall every suite touching money hits.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('recording a counter payment produces a printable receipt', async ({ page }) => {
  const { lease } = await seedLeaseWithBalance()
  const owner = await seedOwner()
  await signIn(page, owner)

  await page.goto(`/leases/${lease.id}`)
  // Lets hydration settle before the first interaction. React can genuinely
  // invoke a server action twice for one press if the form is submitted in
  // the narrow window before hydration attaches - documented Next.js
  // behaviour, not a bug in this form - and a scripted click fires far
  // faster than any person actually would. See offline.ts's own comment on
  // the dedup this item added once this race found it.
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Check number').fill('4521')
  await page.getByRole('button', { name: 'Record this payment' }).click()

  // pdf-lib compresses its text streams (FlateDecode), so the rendered
  // words are not searchable in the raw bytes - `assertRealPdf`'s magic-byte
  // check is the same bar `notices.spec.ts`'s own PDF assertion holds to.
  // The CONTENT (payer name, check number) is exactly what `receiptBlocks`'s
  // own core unit tests would cover; this test's job is that clicking the
  // real button produces a real, downloadable file.
  const receiptLink = page.getByRole('link', { name: 'Print a receipt' })
  await expect(receiptLink).toBeVisible()
  const href = await receiptLink.getAttribute('href')
  await assertRealPdf(page, href!)
})

test('the deposit screen groups undeposited payments and produces a slip', async ({ page }) => {
  const { lease, property, tenant } = await seedLeaseWithBalance()
  const owner = await seedOwner()
  await signIn(page, owner)

  await page.goto(`/leases/${lease.id}`)
  await page.getByLabel('Check number').fill('7788')
  await page.getByRole('button', { name: 'Record this payment' }).click()
  await expect(page.getByRole('link', { name: 'Print a receipt' })).toBeVisible()

  await page.goto('/money/deposits')
  // Scoped to the card, not a bare getByText: the property switcher in the
  // header carries the same property name as a hidden <option>, and
  // getByText matches option text too - the same ambiguous-locator trap
  // CLAUDE.md's route-announcer section documents, just with a combobox
  // instead of a second heading.
  const card = page.getByTestId('deposit-group').filter({ hasText: tenant.lastName })
  await expect(card.getByText(property.name)).toBeVisible()
  // The total and the (single) line amount are both "$1,500.00" here -
  // .first() rather than asserting which of the two duplicate text nodes it
  // is, which is not what this test is checking.
  await expect(card.getByText('$1,500.00').first()).toBeVisible()

  // Scoped to the card, not the page - the owner's scope is the whole
  // portfolio, and another test's own leftover undeposited payment would
  // otherwise make this a strict-mode violation on more than one button.
  await card.getByRole('button', { name: 'Create deposit slip' }).click()

  // Polled against the database, not the UI signal - the same rule
  // leases.spec.ts's own leaseRow helper follows for a create: the write and
  // the render race, and every visible signal on this page can resolve
  // before the batch actually lands.
  //
  // SCOPED TO THE OFFLINE CHANNELS, same filter `listUndepositedDepositGroups`
  // itself uses - see D-169. Recording an out-of-band payment leaves TWO
  // Payment rows on this lease: this one (channel OFFLINE_CHECK, written by
  // `recordOfflinePayment`) and a second, generic one the webhook projection
  // also writes for the same `invoice.updated` event (channel OTHER, no
  // stripePaymentIntentId to dedupe against). The second is a real,
  // pre-existing bug this item found and did not fix (D-169) - it is
  // correctly never deposited, so a query with no channel filter would wait
  // forever for a row that was never supposed to move.
  await expect
    .poll(
      async () =>
        (
          await prisma.payment.findFirst({
            where: { leaseId: lease.id, channel: 'OFFLINE_CHECK' },
          })
        )?.depositBatchId ?? null,
      { timeout: 15_000 },
    )
    .not.toBeNull()

  const slipLink = page.getByRole('link', { name: 'Print the slip' })
  await expect(slipLink).toBeVisible()
  const href = await slipLink.getAttribute('href')
  await assertRealPdf(page, href!)

  // The group is gone once deposited - the whole point of the screen is
  // that a made deposit stops asking to be made again.
  await page.reload()
  await expect(page.getByText(new RegExp(tenant.lastName))).toHaveCount(0)

  const payment = await prisma.payment.findFirstOrThrow({
    where: { leaseId: lease.id, channel: 'OFFLINE_CHECK' },
  })
  expect(payment.depositBatchId).not.toBeNull()
  expect(payment.depositedAt).not.toBeNull()
  expect(payment.depositSlipDocumentId).not.toBeNull()
})

test('two undeposited payments from different receivers appear as separate cards', async ({
  page,
}) => {
  const { lease: leaseA, tenant: tenantA } = await seedLeaseWithBalance()
  const { lease: leaseB, tenant: tenantB } = await seedLeaseWithBalance()
  const owner = await seedOwner()
  const otherStaff = await seedOwner()

  const payerA = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: leaseA.id } })
  const payerB = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: leaseB.id } })
  const receivedAt = new Date()
  await prisma.payment.create({
    data: {
      propertyId: payerA.propertyId,
      leaseId: leaseA.id,
      leasePayerId: payerA.id,
      channel: 'OFFLINE_CASH',
      status: 'SETTLED',
      amountCents: 40_000,
      receivedAt,
      receivedByStaffId: owner.id,
    },
  })
  await prisma.payment.create({
    data: {
      propertyId: payerB.propertyId,
      leaseId: leaseB.id,
      leasePayerId: payerB.id,
      channel: 'OFFLINE_CASH',
      status: 'SETTLED',
      amountCents: 60_000,
      receivedAt,
      receivedByStaffId: otherStaff.id,
    },
  })

  await signIn(page, owner)
  await page.goto('/money/deposits')

  // groupForDeposit's own unit tests cover the grouping rule (day, receiver,
  // entity) directly; this is the one fact only a rendered page can show -
  // that two receivers on the same day land on two separate cards rather
  // than one that would misdescribe who collected what. Scoped to a card
  // containing BOTH names, rather than a page-wide button count: this page
  // reads every undeposited payment in the portfolio, so a bare count would
  // be exactly the "test reads globally in a shared database" trap
  // (CLAUDE.md) - other specs' own undeposited payments are real rows in
  // the same table and must not be able to fail this assertion.
  await expect(page.getByText(new RegExp(tenantA.lastName))).toBeVisible()
  await expect(page.getByText(new RegExp(tenantB.lastName))).toBeVisible()
  const mergedCard = page
    .getByTestId('deposit-group')
    .filter({ hasText: tenantA.lastName })
    .filter({ hasText: tenantB.lastName })
  await expect(mergedCard).toHaveCount(0)
})
