import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone, expectAnnouncedInPlace } from './fixtures.ts'

// The tenant pays (PAY-01, R-037, D-29).
//
// What only a browser can prove here: the amount and the fee a tenant is
// SHOWN match what the server computes, and the form works. The two
// assertions that protect real money are the in-flight subtraction and the
// partial-payment gate - both are core-tested, and both are re-checked here
// through the actual screen, because a correct rule rendered into the wrong
// field is still a tenant paying twice.

// A state code THIS FILE ALONE uses, so its jurisdiction rule cannot be
// masked by another file's (CLAUDE.md: a magic fixture value is only isolated
// if exactly one file uses it - two files both seeding 'ZZ' is how a cap went
// missing for months). Everything else here stays in TX, because the point of
// most of these tests is the rule the product actually ships.
const SURCHARGING_STATE = 'XS'

const ruleIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seed(
  options: {
    collectionMethod?: 'charge_automatically' | 'send_invoice'
    /// Put the property in a jurisdiction that permits a surcharge on EVERY
    /// card (R-037b). Texas does not - it is CREDIT_ONLY per Tex. Bus. & Com.
    /// Code 604A.003, and the funding type is unknown when the fee is quoted,
    /// so no fee is charged there at all. The disclosure still has to be
    /// exercised somewhere, and this is where.
    surchargesEveryCard?: boolean
  } = {},
) {
  const stamp = randomUUID().slice(0, 8)
  if (options.surchargesEveryCard) {
    const rule = await prisma.jurisdictionRule.create({
      data: {
        state: SURCHARGING_STATE,
        version: 1,
        effectiveFrom: new Date('2020-01-01'),
        graceDays: 0,
        lateFeeType: 'NONE',
        cardSurchargePolicy: 'ALL',
        paymentAllocationOrder: [],
      },
    })
    ruleIds.push(rule.id)
  }
  const entity = await prisma.legalEntity.create({
    data: { name: `Pay LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Pay House-${stamp}`,
      addressLine1: '31 Payment Row',
      city: 'Houston',
      state: options.surchargesEveryCard ? SURCHARGING_STATE : 'TX',
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
    data: { firstName: 'Robin', lastName: `Pay-${stamp}`, phone: uniquePhone() },
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
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      collectionMethod: options.collectionMethod ?? 'charge_automatically',
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })

  const charge = await prisma.charge.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      type: 'RENT',
      amountCents: 150_000,
      description: 'February rent',
      dueOn: new Date('2026-02-01'),
    },
  })
  await prisma.ledgerEntry.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      leasePayerId: payer.id,
      chargeId: charge.id,
      type: 'CHARGE',
      amountCents: 150_000,
      description: 'February rent',
      occurredAt: new Date('2026-02-01T12:00:00Z'),
    },
  })

  return { tenant, lease, payer, property }
}

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

test.afterAll(async () => {
  await prisma.authToken.deleteMany({ where: { subjectId: { in: tenantIds } } })
  // Deactivated, never deleted: LedgerEntry is append-only and its foreign
  // keys are RESTRICT, so anything a projected row points at has to stay.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.$disconnect()
})

test.describe('the tenant pay screen', () => {
  test('shows what is owed and what it is made of, before paying', async ({ page }) => {
    const { tenant } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.getByRole('heading', { name: 'Pay rent' })).toBeVisible()
    // The balance, largest thing on the page.
    await expect(page.getByText('$1,500.00').first()).toBeVisible()
    // And the itemisation PAY-01 asks for BEFORE paying.
    // Scoped to the charges list: a bare "Rent" also matches the nav link
    // and the page heading, both of which say "Pay rent".
    const charges = page.getByRole('region', { name: 'What it is made up of' })
    await expect(charges.getByText('Rent', { exact: true })).toBeVisible()
    await expect(charges.getByText('$1,500.00')).toBeVisible()
  })

  test('leads with the FREE rail, and prices the card in money', async ({ page }) => {
    // PAY-01 requires the fee be disclosed before the choice, and a screen
    // that led with the card would quietly cost tenants money.
    //
    // Seeded into a jurisdiction that permits a surcharge on every card, so
    // there IS a fee to disclose - Texas charges none (see the test below).
    const { tenant } = await seed({ surchargesEveryCard: true })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    const rails = page.getByRole('radio')
    await expect(rails.first()).toHaveValue('ACH')
    await expect(page.getByText('Free.', { exact: false })).toBeVisible()

    // THE REGION MUST ALREADY EXIST, checked BEFORE the fee appears (R-101).
    // It used to be rendered together with the fee text, which is a new node
    // rather than a change to a live region — so the one disclosure that
    // alters what a tenant is about to be charged was announced to nobody.
    // axe cannot catch this: it scans a snapshot and cannot know whether
    // anything was ever spoken.
    await expectAnnouncedInPlace(
      page,
      () => page.getByRole('radio', { name: /Card/ }).check(),
      'selecting the card rail on the pay screen',
    )
    // A real number, not a percentage - and grossed up above the nominal
    // 2.9% + 30c, which on $1,500 is $43.80.
    const disclosure = page.getByText(/processing fee/)
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toContainText('$45.')
  })

  test('CHARGES NO CARD FEE IN TEXAS, AND STILL OFFERS THE CARD', async ({ page }) => {
    // R-037b, and the two halves are one test because the second is what
    // makes the first safe to ship.
    //
    // Tex. Bus. & Com. Code 604A.003 permits a surcharge on a credit card and
    // bars one on debit or stored-value. Stripe reports the funding type only
    // once a payment method exists, and PAY-01 wants the fee shown BEFORE the
    // tenant picks a rail - so the quote cannot tell which kind of card this
    // is, and a card it cannot show was credit must not be surcharged. Before
    // this item the rule was a boolean reading `true` and every debit card
    // paying Texas rent was surcharged unlawfully.
    //
    // AND THE CARD RAIL STAYS OPEN. `railsFor` used to be handed
    // `cardSurchargePermitted` as its `cardPermitted` flag, so the moment the
    // surcharge stopped being permitted the tenant was told "Card payments
    // are not available for this property" - turning a fee question into a
    // rail outage. Not surcharging means the owner absorbs the cost.
    const { tenant } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    const card = page.getByRole('radio', { name: /Card/ })
    await expect(card).toBeEnabled()
    await card.check()

    await expect(page.getByText(/processing fee/)).toHaveCount(0)
    // The button still offers to charge the rent and nothing above it.
    await expect(page.getByRole('button', { name: 'Pay $1,500.00' })).toBeVisible()
  })

  test('never offers retail cash, and says why', async ({ page }) => {
    const { tenant } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    const cash = page.getByRole('radio', { name: /Cash at a store/ })
    await expect(cash).toBeDisabled()
    await expect(page.getByText('not set up', { exact: false })).toBeVisible()
  })

  test('SUBTRACTS money already on its way rather than asking for it twice', async ({ page }) => {
    // The ledger correctly does not move for an in-flight ACH debit. The
    // screen must still not invite a second payment for the same rent.
    const { tenant, lease, payer, property } = await seed()
    await prisma.payment.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        channel: 'ACH',
        status: 'PENDING',
        amountCents: 100_000,
        receivedAt: new Date(),
        stripePaymentIntentId: `pi_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })

    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.getByText('already on its way', { exact: false })).toBeVisible()
    // Prefilled with what is LEFT, not with the full balance.
    await expect(page.getByLabel('How much are you paying?')).toHaveValue('500.00')
  })

  test('tells an autopay tenant they pay the full amount', async ({ page }) => {
    // D-29: Stripe cannot take a partial payment on `charge_automatically`,
    // so the screen must not offer one it would have to refuse.
    const { tenant } = await seed({ collectionMethod: 'charge_automatically' })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')
    await expect(page.getByText('pays the full amount', { exact: false })).toBeVisible()
  })

  test('offers an invoiced tenant the choice to pay part of it', async ({ page }) => {
    const { tenant } = await seed({ collectionMethod: 'send_invoice' })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')
    await expect(page.getByText('pay part of it', { exact: false })).toBeVisible()
  })

  test('REFUSES an amount larger than the balance, whatever the form said', async ({ page }) => {
    // The action recomputes the balance and never trusts the submitted
    // amount. Typed into the real field, so this exercises the actual path a
    // stale page or a hand-crafted request would take.
    const { tenant, payer } = await seed({ collectionMethod: 'send_invoice' })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await page.getByLabel('How much are you paying?').fill('99999')
    await page.getByRole('button', { name: /^Pay/ }).click()

    await expect(page.getByText('more than you owe', { exact: false })).toBeVisible()
    // And nothing was started.
    expect(
      await prisma.auditLog.count({
        where: { action: 'payment.intent_created', entityId: payer.id },
      }),
    ).toBe(0)
  })

  test('starts a payment and records the intent WITH its fee', async ({ page }) => {
    // The fee is what somebody disputes later, so it is on the trail at the
    // moment it was quoted - not recomputed afterwards against a
    // jurisdiction rule that may since have been re-versioned.
    //
    // In a jurisdiction that surcharges every card, because Texas now
    // surcharges none (R-037b). The Texas side is asserted below, and the
    // reason it needs its own assertion is that a zero fee there is the
    // CORRECT outcome rather than a missing one - so a trail that recorded
    // only the amount could not tell the two apart.
    const { tenant, payer } = await seed({
      collectionMethod: 'send_invoice',
      surchargesEveryCard: true,
    })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await page.getByLabel('How much are you paying?').fill('500')
    await page.getByRole('radio', { name: /Card/ }).check()
    await page.getByRole('button', { name: /^Pay/ }).click()

    await expect
      .poll(
        async () =>
          prisma.auditLog.count({
            where: { action: 'payment.intent_created', entityId: payer.id },
          }),
        { timeout: 15_000 },
      )
      .toBe(1)

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'payment.intent_created', entityId: payer.id },
    })
    const after = entry.after as {
      amountCents: number
      feeCents: number
      totalCents: number
      cardSurchargePolicy: string
      cardFunding: string | null
    }
    expect(after.amountCents).toBe(50_000)
    expect(after.feeCents).toBeGreaterThan(0)
    expect(after.totalCents).toBe(after.amountCents + after.feeCents)
    expect(after.cardSurchargePolicy).toBe('ALL')
  })

  test('records WHY a Texas card payment carried no fee, not just that it did not', async ({
    page,
  }) => {
    // The other half of R-037b's trail. Under CREDIT_ONLY with a funding type
    // nobody can read yet, zero is the right answer - and six months later
    // "we charged you nothing because we could not prove your card was
    // credit" and "we charged you nothing because this state forbids the fee"
    // are different defences. Without the policy and the funding on the row
    // they are the same silence.
    const { tenant, payer } = await seed({ collectionMethod: 'send_invoice' })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await page.getByLabel('How much are you paying?').fill('500')
    await page.getByRole('radio', { name: /Card/ }).check()
    await page.getByRole('button', { name: /^Pay/ }).click()

    await expect
      .poll(
        async () =>
          prisma.auditLog.count({
            where: { action: 'payment.intent_created', entityId: payer.id },
          }),
        { timeout: 15_000 },
      )
      .toBe(1)

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'payment.intent_created', entityId: payer.id },
    })
    const after = entry.after as {
      amountCents: number
      feeCents: number
      totalCents: number
      cardSurchargePolicy: string
      cardFunding: string | null
    }
    expect(after.feeCents).toBe(0)
    // The tenant is charged the rent and not a cent more.
    expect(after.totalCents).toBe(50_000)
    expect(after.cardSurchargePolicy).toBe('CREDIT_ONLY')
    expect(after.cardFunding).toBe('unknown')
  })

  test('accessibility (§6.4, WCAG 2.1 AA)', async ({ page }) => {
    const { tenant } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')
    await expect(page.getByRole('heading', { name: 'Pay rent' })).toBeVisible()

    const { default: AxeBuilder } = await import('@axe-core/playwright')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})

test.describe('the tenant\'s own statement (R-043)', () => {
  /// A charge, a payment against it, and a reversal — the three shapes a
  /// tenant ever sees, including the one D-11 makes unavoidable.
  async function seedWithHistory() {
    const { tenant, lease, property, payer } = await seed()
    const paid = await prisma.ledgerEntry.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        type: 'PAYMENT',
        amountCents: -50_000,
        description: 'Card payment',
        occurredAt: new Date('2026-02-05T12:00:00Z'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        type: 'REVERSAL',
        amountCents: 50_000,
        description: 'Card payment returned',
        occurredAt: new Date('2026-02-09T12:00:00Z'),
        reversesId: paid.id,
      },
    })
    return { tenant, lease }
  }

  test('shows what was charged AND what was paid — the question the pay screen cannot answer', async ({
    page,
  }) => {
    const { tenant } = await seedWithHistory()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    // Reachable from the pay screen without hunting.
    await page.getByRole('link', { name: /See everything you have paid/ }).click()
    await expect(page).toHaveURL(/\/portal\/pay\/history$/)

    await expect(page.getByRole('heading', { name: 'Your payments' })).toBeVisible()
    await expect(page.getByText('February rent')).toBeVisible()
    // The payment itself — the thing "did you get my payment?" is about, and
    // the thing the pay screen never showed.
    await expect(page.getByText('Card payment', { exact: true })).toBeVisible()
  })

  test('shows a reversal as a reversal, rather than quietly dropping it', async ({ page }) => {
    // D-11 keeps the original row and adds a reversal beside it. A tenant who
    // sees a payment listed and then reversed has to be told which, or the
    // statement reads as though it double-counted.
    const { tenant } = await seedWithHistory()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay/history')

    await expect(page.getByText('Card payment returned')).toBeVisible()
    await expect(page.getByText('This was later reversed')).toBeVisible()
  })

  test('THE INVARIANT: the tenant and the office see the same balance', async ({ page }) => {
    // $1,500 charged, $500 paid, that payment returned — so $1,500 owed. If
    // the portal and the admin ledger ever disagree, the disagreement IS the
    // dispute this feature exists to prevent, and it would be a worse bug
    // than showing nothing.
    const { tenant, lease } = await seedWithHistory()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay/history')

    await expect(page.getByText('$1,500.00').first()).toBeVisible()

    const rows = await prisma.ledgerEntry.findMany({
      where: { leaseId: lease.id },
      select: { amountCents: true },
    })
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(150_000)
  })

  test('accessibility', async ({ page }) => {
    const { tenant } = await seedWithHistory()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay/history')

    const { default: AxeBuilder } = await import('@axe-core/playwright')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
