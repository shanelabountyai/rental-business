import { randomUUID } from 'node:crypto'
import { mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Pay from the link in the reminder, with no login (PAY-01, COMM-02, R-046).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES HERE: THE PAGE IS REACHABLE WITH NO SESSION AND
// REACHES NOTHING ELSE.
//
// The decision table is unit-tested against the database in
// lib/portal/pay-link.test.ts. What that cannot show is the part D-45 turns
// on — that holding this token gets you the payment screen and NOT the
// tenant's messages, papers or lease documents. A session-based
// implementation would pass every unit test above and fail exactly that.
// ==========================================================================

/**
 * Mints a pay link the way `issuePayLink` does.
 *
 * NOT by importing it: that module is `server-only`, which cannot be loaded
 * into Playwright's plain-Node context — the same reason `pay.spec.ts` mints
 * its own TENANT_MAGIC_LINK rather than calling the app's helper. The shape
 * is mirrored deliberately, including the revoke-then-create, so a drift
 * between this and the real minter shows up as a failing test here rather
 * than as a link that works only in tests.
 */
async function mintPayLink(args: {
  leasePayerId: string
  tenantId: string
  leaseId: string
  notificationKey?: string | null
}) {
  const minted = mintToken('TENANT_PAY_LINK')
  await prisma.authToken.updateMany({
    where: {
      purpose: 'TENANT_PAY_LINK',
      subjectId: args.leasePayerId,
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  })
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_PAY_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'LeasePayer',
      subjectId: args.leasePayerId,
      expiresAt: minted.expiresAt,
      metadata: {
        tenantId: args.tenantId,
        leaseId: args.leaseId,
        notificationKey: args.notificationKey ?? null,
      },
    },
  })
  return { token: minted.token }
}

/// What `revokePayLinks` does, for the same server-only reason as above.
async function revokeFor(leasePayerId: string) {
  await prisma.authToken.updateMany({
    where: { purpose: 'TENANT_PAY_LINK', subjectId: leasePayerId, consumedAt: null },
    data: { consumedAt: new Date() },
  })
}

const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seed(options: { collectionPaused?: boolean } = {}) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `PayLink LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `PayLink House-${stamp}`,
      addressLine1: '12 Token Terrace',
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
    // NO EMAIL — the persona this item exists for. An email-only portal login
    // is a wall this tenant cannot get over at all.
    data: {
      firstName: `Robin${stamp}`,
      lastName: `PayLink-${stamp}`,
      email: null,
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
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      collectionMethod: 'send_invoice',
      collectionPaused: options.collectionPaused ?? false,
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

  const link = await mintPayLink({
    leasePayerId: payer.id,
    tenantId: tenant.id,
    leaseId: lease.id,
    notificationKey: `rent-due:today:${payer.id}:2026-02-01`,
  })

  return { tenant, lease, payer, property, token: link.token }
}

test.afterAll(async () => {
  // DEACTIVATED, NOT DELETED. `LedgerEntry` is append-only and its foreign
  // keys are RESTRICT, so a projected row pins the LeasePayer, Lease and
  // Property it points at — deleting any of them fails at the database.
  // That is the product working (the projection is evidence and outlives
  // what it refers to), and it is the cleanup rule CLAUDE.md states: retire
  // or deactivate, never delete a row an append-only table references.
  //
  // The first draft of this hook deleted the payers and every test in the
  // file reported as failing, on an error that had nothing to do with what
  // any of them asserted.
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.leasePayer.updateMany({
    where: { propertyId: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('paying from a link, with no login (R-046)', () => {
  test('OPENS THE PAYMENT SCREEN WITH NO SESSION AT ALL', async ({ page }) => {
    const { token, tenant } = await seed()

    await page.goto(`/pay/${token}`)

    // Greeted by name, shown the balance, offered the form — without ever
    // having signed in.
    await expect(page.getByRole('heading', { name: new RegExp(tenant.firstName) })).toBeVisible()
    await expect(page.getByText('$1,500.00').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /pay/i }).first()).toBeVisible()
  })

  test('THE TOKEN OPENS NOTHING ELSE — the whole point of D-45', async ({ page }) => {
    // A session-scoped implementation would pass every other test in this
    // file and fail this one. Holding a live pay token must not read the
    // tenant's messages, papers or maintenance history.
    const { token } = await seed()
    await page.goto(`/pay/${token}`)

    for (const route of ['/portal', '/portal/messages', '/portal/papers', '/portal/pay/history']) {
      const response = await page.goto(route)
      // Redirected to the login wall rather than served. `waitForURL` rather
      // than a status assertion because a redirect chain ends at 200 on the
      // login page itself.
      await expect(page).toHaveURL(/\/portal\/login/)
      expect(response?.status()).toBeLessThan(500)
    }
  })

  test('a revoked link stops working, and says so distinctly from expired', async ({ page }) => {
    const { token, payer } = await seed()
    await page.goto(`/pay/${token}`)
    await expect(page.getByRole('button', { name: /pay/i }).first()).toBeVisible()

    // What a legal-action hold (R-047) does.
    await revokeFor(payer.id)

    await page.goto(`/pay/${token}`)
    await expect(page.getByText(/no longer active/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /pay/i })).toHaveCount(0)
  })

  test('REISSUING KILLS THE PREVIOUS LINK, so one live link per payer', async ({ page }) => {
    const { token, payer, lease, tenant } = await seed()

    await mintPayLink({
      leasePayerId: payer.id,
      tenantId: tenant.id,
      leaseId: lease.id,
    })

    await page.goto(`/pay/${token}`)
    await expect(page.getByText(/no longer active/i)).toBeVisible()
  })

  test('refuses a paused tenancy without explaining why (PAY-12)', async ({ page }) => {
    const { token } = await seed({ collectionPaused: true })

    await page.goto(`/pay/${token}`)
    await expect(page.getByText(/not available on this account/i)).toBeVisible()
    // R-047 owns the message that explains a hold. This screen must not.
    await expect(page.getByText(/legal|eviction|court/i)).toHaveCount(0)
  })

  test('refuses a forged token', async ({ page }) => {
    await page.goto('/pay/not-a-real-token')
    await expect(page.getByText(/isn.t working/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /pay/i })).toHaveCount(0)
  })

  test('is not indexable — the URL itself is the credential', async ({ page }) => {
    const { token } = await seed()
    await page.goto(`/pay/${token}`)
    const robots = page.locator('meta[name="robots"]')
    await expect(robots).toHaveAttribute('content', /noindex/)
  })
})
