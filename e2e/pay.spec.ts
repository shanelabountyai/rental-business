import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// The tenant pays (PAY-01, R-037, D-29).
//
// What only a browser can prove here: the amount and the fee a tenant is
// SHOWN match what the server computes, and the form works. The two
// assertions that protect real money are the in-flight subtraction and the
// partial-payment gate - both are core-tested, and both are re-checked here
// through the actual screen, because a correct rule rendered into the wrong
// field is still a tenant paying twice.

const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seed(options: { collectionMethod?: 'charge_automatically' | 'send_invoice' } = {}) {
  const stamp = randomUUID().slice(0, 8)
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
    const { tenant } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    const rails = page.getByRole('radio')
    await expect(rails.first()).toHaveValue('ACH')
    await expect(page.getByText('Free.', { exact: false })).toBeVisible()

    await page.getByRole('radio', { name: /Card/ }).check()
    // A real number, not a percentage - and grossed up above the nominal
    // 2.9% + 30c, which on $1,500 is $43.80.
    const disclosure = page.getByText(/processing fee/)
    await expect(disclosure).toBeVisible()
    await expect(disclosure).toContainText('$45.')
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
    const after = entry.after as { amountCents: number; feeCents: number; totalCents: number }
    expect(after.amountCents).toBe(50_000)
    expect(after.feeCents).toBeGreaterThan(0)
    expect(after.totalCents).toBe(after.amountCents + after.feeCents)
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
