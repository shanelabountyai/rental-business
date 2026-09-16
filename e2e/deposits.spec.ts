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

/// An owner with a password and NO enrolled second factor. `seedOwner` above
/// enrols one, which is why every existing test here proved the deposit
/// screen works and none of them proved what it says to the person who has
/// not enrolled yet.
async function seedOwnerWithoutMfa() {
  const email = `deposits-nomfa-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Unenrolled Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
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
  // UNSCOPED, and that is the assertion (R-171, D-177). Until this item,
  // recording an out-of-band payment left TWO Payment rows on this lease -
  // this one, and a generic `channel: OTHER` duplicate the webhook projection
  // wrote for the same `invoice.updated` event (D-169) - so this poll had to
  // be filtered to `OFFLINE_CHECK` or it would wait forever on a row that was
  // never supposed to move. The counter payment is now one row, so the filter
  // is gone and its absence is what proves it end to end.
  await expect
    .poll(
      async () =>
        (
          await prisma.payment.findFirst({ where: { leaseId: lease.id } })
        )?.depositBatchId ?? null,
      { timeout: 15_000 },
    )
    .not.toBeNull()
  expect(await prisma.payment.count({ where: { leaseId: lease.id } })).toBe(1)

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


test('an owner who has not proved a second factor is sent to enrol, not told their role lacks the permission', async ({
  page,
}) => {
  // R-184's demo walk found this on the first privileged screen it opened.
  //
  // `/money/deposits` guards on `ledger.adjust`, which is privileged, and
  // `propertyScope` collapses "holds the grant but has not proved a second
  // factor" into an EMPTY SCOPE - indistinguishable from holding no grant at
  // all. `requireScope` then reported `no_permission`, so the owner of the
  // whole portfolio was told "Your role doesn't include this. Ask whoever
  // manages access if you need it. Missing permission: ledger.adjust" -
  // wrong about the permission they hold, and pointing them at themselves.
  //
  // `requirePermission` has always made this distinction and sends the
  // person to enrolment; `requireScope`, 100 lines below it in the same
  // file, did not. This asserts the destination rather than the copy,
  // because the copy is /account's business.
  const owner = await seedOwnerWithoutMfa()
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
  await page.goto('/login')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')

  await page.goto('/money/deposits')
  await expect(page).toHaveURL(/\/account\?mfa=required/)
})

// ==========================================================================
// R-209: THE APPLIED DEPOSIT REACHES THE LEDGER.
//
// `finalizeDisposition` wrote `appliedCents` onto the Deposit row and into
// the letter and nowhere else, so a tenant who moved out owing the deposit
// exactly got a letter saying it was settled while `balanceCents()` went on
// reporting the whole arrears - to the lease page, to `statementForPeriod`,
// to R-083's attorney packet, and to anyone handed the file for collection.
//
// DRIVEN THROUGH THE BROWSER, not against the action, because
// `finalizeDisposition` is session-dependent (`requirePermission`) - the
// same split `delist.test.ts` documents. It asserts the PROJECTION rather
// than the letter: the letter was always right, and the ledger is the half
// that was missing.
// ==========================================================================

async function seedDisposableDeposit(heldCents: number) {
  const seeded = await seedLeaseWithBalance()
  await prisma.lease.update({
    where: { id: seeded.lease.id },
    data: { status: 'ENDED', moveOutAt: new Date('2026-09-30T12:00:00Z') },
  })
  const deposit = await prisma.deposit.create({
    data: {
      propertyId: seeded.property.id,
      leaseId: seeded.lease.id,
      heldCents,
      receivedAt: new Date('2026-01-01T12:00:00Z'),
      dispositionDueOn: new Date('2026-10-30T00:00:00Z'),
    },
  })
  return { ...seeded, deposit }
}

test('finalizing a disposition settles the arrears on the ledger, not just in the letter', async ({
  page,
}) => {
  // Held exactly covers the $1,500 the fixture leaves outstanding, so the
  // letter's own words are "your deposit has been fully applied; no refund
  // is due" - and nothing is owed back, which is what sends the page on to
  // the notice once it is written.
  const { lease, deposit } = await seedDisposableDeposit(150_000)
  const owner = await seedOwner()
  await signIn(page, owner)

  await page.goto(`/leases/${lease.id}/deposit`)
  await expect(page.getByRole('heading', { name: 'Totals' })).toBeVisible()
  await expect(page.getByText('Outstanding balance')).toBeVisible()

  await page.getByLabel('Forwarding address').fill('19 Somewhere Else, Houston TX 77002')
  await page.getByLabel(/cannot be undone/).check()
  await page.getByRole('button', { name: 'Finalize disposition' }).click()

  // The letter exists: a disposition that refunds nothing has nothing left
  // to do on this screen and hands off to R-051's notice page.
  await page.waitForURL(/\/notices\/[a-z0-9]+$/)

  // THE ASSERTION THIS ITEM EXISTS FOR. Polled rather than read once: the
  // simulator projects inside the push, but real Stripe delivers the event
  // afterwards, and an assertion that only holds against the simulator is
  // not the one to write.
  await expect
    .poll(async () => {
      const rows = await prisma.ledgerEntry.findMany({
        where: { leaseId: lease.id },
        select: { amountCents: true },
      })
      return rows.reduce((total, row) => total + row.amountCents, 0)
    })
    .toBe(0)

  // ...and it got there as a PAYMENT off a real Payment row, never as a
  // hand-written credit. `LedgerEntry` is an append-only projection of
  // Stripe (D-11) and the webhook is its only production writer; a row here
  // that no payment produced would be the reconciliation bug the schema
  // comment names.
  //
  // Summed rather than counted: `planAllocation` splits a payment into one
  // entry per debt it lands on, so the NUMBER of rows is a property of
  // whatever charges the fixture happens to carry. What must hold either way
  // is the total and the fact that every one of them names a Payment.
  const credits = await prisma.ledgerEntry.findMany({
    where: { leaseId: lease.id, type: 'PAYMENT' },
    select: { amountCents: true, paymentId: true },
  })
  expect(credits.reduce((total, row) => total + row.amountCents, 0)).toBe(-150_000)
  expect(credits.every((row) => row.paymentId !== null)).toBe(true)

  // EXACTLY ONE Payment row. D-169's duplicate - our row plus one minted by
  // the event - doubled every counter payment in the dashboard's collected
  // tile before D-177 fixed the ordering, and this path writes its row in
  // the same order for the same reason.
  const payments = await prisma.payment.findMany({
    where: { leaseId: lease.id },
    select: { channel: true, amountCents: true, receivedByStaffId: true },
  })
  expect(payments).toHaveLength(1)
  expect(payments[0]).toMatchObject({ channel: 'OTHER', amountCents: 150_000 })
  expect(payments[0].receivedByStaffId).toBe(owner.id)

  // The Deposit row and the ledger now agree, which is the whole point.
  const after = await prisma.deposit.findUniqueOrThrow({
    where: { id: deposit.id },
    select: { appliedCents: true, refundedCents: true },
  })
  expect(after).toEqual({ appliedCents: 150_000, refundedCents: 0 })
})

test('a disposition with nothing outstanding touches the ledger not at all', async ({ page }) => {
  // The negative case, and it is not decoration: `ledgerAppliedCents` is
  // `min(applied, outstanding)`, so a deposit consumed entirely by DAMAGE
  // must credit nothing - deductions were never on the ledger, and paying
  // them down against it would forgive rent nobody paid.
  const { lease, property } = await seedDisposableDeposit(300_000)
  // Clear the arrears the fixture seeds, so the only thing left to apply is
  // the deduction below.
  await prisma.ledgerEntry.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'PAYMENT',
      amountCents: -150_000,
      description: 'September rent paid',
      occurredAt: new Date('2026-09-02T00:00:00Z'),
    },
  })
  const owner = await seedOwner()
  await signIn(page, owner)

  await page.goto(`/leases/${lease.id}/deposit`)
  await page.getByLabel('Description').fill('Replace the kitchen worktop')
  await page.getByLabel('Amount ($)').fill('900')
  await page.getByRole('button', { name: 'Add deduction' }).click()
  // `exact: true` because `getByText` is a case-insensitive SUBSTRING match
  // and the remove button carries an sr-only " the <description> deduction".
  // The more specific locator, never a relaxed assertion (CLAUDE.md).
  await expect(page.getByText('Replace the kitchen worktop', { exact: true })).toBeVisible()

  await page.getByLabel('Forwarding address').fill('19 Somewhere Else, Houston TX 77002')
  await page.getByLabel(/cannot be undone/).check()
  await page.getByRole('button', { name: 'Finalize disposition' }).click()

  // `finalizeDisposition` redirects to the letter whatever the totals say -
  // the deposit screen's own `refundedCents === 0` redirect is about a later
  // GET, not about where the action lands.
  await page.waitForURL(/\/notices\/[a-z0-9]+$/)

  expect(await prisma.payment.count({ where: { leaseId: lease.id } })).toBe(0)
  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId: lease.id },
    select: { amountCents: true },
  })
  expect(rows.reduce((total, row) => total + row.amountCents, 0)).toBe(0)
})

test('damage beyond the deposit becomes a receivable on the former-tenants screen, and can be written off', async ({
  page,
}) => {
  // R-215. $1,000 held against $1,500 of arrears (the fixture's) and $900 of
  // damage. Ledger first (R-209): the deposit settles $1,000 of the arrears,
  // so ALL $900 of damage is uncovered and $500 of arrears is left. The
  // tenant owes $1,400 - and before this item $900 of it existed only as a
  // sentence in the letter.
  const { lease, property, deposit, tenant } = await seedDisposableDeposit(100_000)
  const owner = await seedOwner()
  await signIn(page, owner)

  await page.goto(`/leases/${lease.id}/deposit`)
  await page.getByLabel('Description').fill('Replace the scorched countertop')
  await page.getByLabel('Amount ($)').fill('900')
  await page.getByRole('button', { name: 'Add deduction' }).click()
  await expect(page.getByText('Replace the scorched countertop', { exact: true })).toBeVisible()

  await page.getByLabel('Forwarding address').fill('19 Somewhere Else, Houston TX 77002')
  await page.getByLabel(/cannot be undone/).check()
  await page.getByRole('button', { name: 'Finalize disposition' }).click()
  await page.waitForURL(/\/notices\/[a-z0-9]+$/)

  // Billed through Stripe as its own charge, linked, never hand-written onto
  // the ledger (D-11). Polled: real Stripe projects after the push returns.
  await expect
    .poll(async () => {
      const rows = await prisma.ledgerEntry.findMany({
        where: { leaseId: lease.id },
        select: { amountCents: true },
      })
      return rows.reduce((total, row) => total + row.amountCents, 0)
    })
    .toBe(140_000)
  const charge = await prisma.charge.findUniqueOrThrow({
    where: { depositId: deposit.id },
    select: { amountCents: true, stripeInvoiceId: true, ledgerEntries: { select: { type: true } } },
  })
  expect(charge.amountCents).toBe(90_000)
  expect(charge.stripeInvoiceId).not.toBeNull()
  expect(charge.ledgerEntries).toEqual([{ type: 'CHARGE' }])

  // Narrowed to this property: `rental_test` holds thousands of ended leases.
  await page.context().addCookies([
    { name: 'rental_scope', value: `property:${property.id}`, url: page.url() },
  ])
  await page.goto('/money/former-tenants')
  const tenantName = `${tenant.firstName} ${tenant.lastName}`
  const row = page.getByRole('row', { name: new RegExp(tenantName) })
  await expect(row).toContainText('$1,400.00')

  await row.locator('summary').click()
  await row.getByLabel(`Why ${tenantName}'s balance is being written off`).fill('Skipped to another state; not worth a filing')
  await row.getByRole('button', { name: `Write off ${tenantName}'s balance` }).click()

  // A signal only the returned action can produce: the row under its new
  // heading, carrying the reason.
  await expect(
    page.getByRole('region', { name: 'Written off' }).getByText(/Skipped to another state/),
  ).toBeVisible()

  // Recorded, not deleted: the ledger still says $1,400 is owed.
  const writeOff = await prisma.receivableWriteOff.findFirstOrThrow({
    where: { leaseId: lease.id },
    select: { amountCents: true, staffUserId: true },
  })
  expect(writeOff).toEqual({ amountCents: 140_000, staffUserId: owner.id })
  const balance = await prisma.ledgerEntry.aggregate({
    where: { leaseId: lease.id },
    _sum: { amountCents: true },
  })
  expect(balance._sum.amountCents).toBe(140_000)
  expect(
    await prisma.auditLog.count({ where: { action: 'receivable.written_off', propertyId: property.id } }),
  ).toBe(1)
})
