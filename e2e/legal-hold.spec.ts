import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// PAY-12's legal-action payment controls, from the tenant's side (R-047).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES: WHAT THE TENANT ACTUALLY READS.
//
// The decision table is unit-tested in packages/core, and the Stripe pause is
// proved in lib/payments/legal-hold.test.ts. Neither can show the thing PAY-12
// is most specific about — that the refusal is NEUTRAL. A screen that said
// "your account is in eviction proceedings" would pass every test in both
// files and be a disclosure to whoever is holding the phone, on a page that
// is not lawful service of anything.
// ==========================================================================

const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []

async function seed(
  hold: {
    collectionPaused?: boolean
    blockPartialPayments?: boolean
    certifiedFundsOnly?: boolean
  } = {},
) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Hold LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Hold House-${stamp}`,
      addressLine1: '9 Notice Way',
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
    data: { firstName: 'Sam', lastName: `Held-${stamp}`, phone: uniquePhone() },
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
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      collectionMethod: 'send_invoice',
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      collectionPaused: hold.collectionPaused ?? false,
      blockPartialPayments: hold.blockPartialPayments ?? false,
      certifiedFundsOnly: hold.certifiedFundsOnly ?? false,
      ...(hold.collectionPaused || hold.blockPartialPayments || hold.certifiedFundsOnly
        ? {
            paymentHoldReason: 'Notice to vacate served; case opened.',
            paymentHoldSetAt: new Date(),
          }
        : {}),
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

/// Nothing a tenant reads may name the legal action. Asserted as a set so a
/// new message cannot quietly introduce one of these words.
const FORBIDDEN = /evict|eviction|notice to vacate|legal action|court|attorney|lawyer|proceeding/i

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

test.describe('what a held tenant sees (PAY-12)', () => {
  test('BLOCKED ONLINE: no payment form, and the reason is never named', async ({ page }) => {
    const { tenant } = await seed({ collectionPaused: true })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.getByText(/Online payments are not available on this account/i)).toBeVisible()
    // No form at all — not a form that submits and then refuses.
    await expect(page.locator('main').getByRole('button', { name: /^Pay \$/ })).toHaveCount(0)

    // THE ASSERTION PAY-12 IS MOST SPECIFIC ABOUT.
    await expect(page.locator('main')).not.toContainText(FORBIDDEN)
  })

  test('CERTIFIED FUNDS ONLY: says what IS accepted, still names no reason', async ({ page }) => {
    // "Not available" alone would send somebody back to the portal to try
    // again. This one has a real alternative, so it says so.
    const { tenant } = await seed({ certifiedFundsOnly: true })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.getByText(/cashier|money order/i)).toBeVisible()
    await expect(page.locator('main').getByRole('button', { name: /^Pay \$/ })).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText(FORBIDDEN)
  })

  test('BLOCKED PARTIAL: the form still works, but only for the full balance', async ({
    page,
  }) => {
    // The tenant may still cure — in full. Closing the screen entirely would
    // take away the very thing that ends the case.
    const { tenant } = await seed({ blockPartialPayments: true })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.locator('main').getByRole('button', { name: /^Pay \$/ }).first()).toBeVisible()
    // The amount field is fixed at the full balance rather than free.
    await expect(page.getByText('$1,500.00').first()).toBeVisible()
    await expect(page.locator('main')).not.toContainText(FORBIDDEN)
  })

  test('an unheld tenancy is unaffected', async ({ page }) => {
    const { tenant } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')

    await expect(page.locator('main').getByRole('button', { name: /^Pay \$/ }).first()).toBeVisible()
    await expect(
      page.getByText(/not available on this account|cashier/i),
    ).toHaveCount(0)
  })

  test('A REFUSED ATTEMPT IS LOGGED TO THE CASE FILE', async ({ page }) => {
    // PAY-12 asks for this, and the reason runs opposite to how it reads: an
    // eviction turning on "they never tried to pay" has to be arguable
    // against a record of every time they did.
    //
    // Driven through the ACTION rather than the screen, because a blocked
    // screen deliberately renders no form to submit — the refusal that gets
    // logged is the one a stale page or a crafted request produces.
    const { tenant, payer } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto('/portal/pay')
    await expect(page.locator('main').getByRole('button', { name: /^Pay \$/ }).first()).toBeVisible()

    // The hold lands AFTER the page was rendered — the stale-page case.
    await prisma.leasePayer.update({
      where: { id: payer.id },
      data: {
        collectionPaused: true,
        paymentHoldReason: 'Notice served after this page was rendered.',
        paymentHoldSetAt: new Date(),
      },
    })

    await page.locator('main').getByRole('button', { name: /^Pay \$/ }).first().click()

    // Refused, neutrally, from the write path.
    await expect(page.getByText(/not available on this account/i)).toBeVisible()
    await expect(page.locator('main')).not.toContainText(FORBIDDEN)

    const logged = await prisma.auditLog.findFirst({
      where: { entityId: payer.id, action: 'payment.hold_refused' },
      orderBy: { occurredAt: 'desc' },
    })
    expect(logged, 'the refused attempt should be on the audit trail').not.toBeNull()
    // WHAT THEY TRIED TO PAY. A tenant who repeatedly offered the full
    // balance has a materially different case from one who offered $20 once.
    expect(logged!.after).toMatchObject({ refusal: 'online_blocked' })
  })
})
