import { randomUUID } from 'node:crypto'
import { stripeSignatureHeader } from '@rental/core/billing'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST as platform } from '@/app/api/webhooks/stripe/route.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { SimulatedBillingProvider } from '@/lib/billing/simulated-adapter.ts'
import { processStripeEvent } from '@/lib/billing/webhook.ts'
import { setupFacts } from '@/lib/setup/checklist.ts'
import {
  CollectionRefusedError,
  collectionRefusal,
  deauthorizeSimulated,
  startStripeOnboarding,
  stripeRow,
  submitSimulatedOnboarding,
} from './stripe-onboarding.ts'

// R-277b (PRD 10 §2.2, §2.4). Onboarding runs against the simulated
// connector, whose own state (`SimulatedStripeAccount`, D-27) is what its
// `account.updated` events are built from. No action is called, so no
// AuditLog row pins the org. The org IS left standing: its PlatformFee row is
// append-only and restricts the delete, so cleanup retires what it can.

const stamp = `r277b-${randomUUID().slice(0, 8)}`
const URLS = { refreshUrl: 'https://x.example.test/money/stripe', returnUrl: 'https://x.example.test/money/stripe' }
const SECRET = 'whsec_platform_r277b'
let orgA = ''
let propertyId = ''
let entityId = ''
const previous = { secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY }

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  delete process.env.STRIPE_SECRET_KEY
  orgA = (await prisma.organization.create({ data: { slug: stamp, name: `Org ${stamp}` } })).id
  entityId = (await prisma.legalEntity.create({ data: { orgId: orgA, name: stamp, type: 'LLC' } })).id
  propertyId = (
    await prisma.property.create({
      data: {
        orgId: orgA,
        legalEntityId: entityId,
        name: stamp,
        addressLine1: '1 Connect Way',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
  ).id
})

afterAll(async () => {
  for (const [name, value] of [['STRIPE_WEBHOOK_SECRET', previous.secret], ['STRIPE_SECRET_KEY', previous.key]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const row = await stripeRow(orgA)
  await prisma.task.deleteMany({ where: { propertyId } })
  await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  if (row?.accountId) await prisma.simulatedStripeAccount.deleteMany({ where: { accountId: row.accountId } })
})

const tasks = () => prisma.task.findMany({ where: { propertyId, type: 'stripe_collection_refused' } })

describe('Stripe onboarding, simulated (R-277b)', () => {
  let accountId = ''

  it('refuses org #0, which bills on the platform account (D-362)', async () => {
    expect(await startStripeOnboarding('org_0', URLS)).toMatchObject({ ok: false })
  })

  it('creates an account and a link into the hosted stand-in; a second press links the same account', async () => {
    const started = await startStripeOnboarding(orgA, URLS)
    expect(started.ok).toBe(true)
    const row = (await stripeRow(orgA))!
    expect(row).toMatchObject({ status: 'ONBOARDING', provisionedBy: 'simulated' })
    accountId = row.accountId!
    expect(accountId).toMatch(/^acct_sim[0-9a-f]{16}$/)
    expect(started).toEqual({ ok: true, url: `https://x.example.test/money/stripe/simulated/${accountId}` })
    expect(await startStripeOnboarding(orgA, URLS)).toEqual(started)
    expect((await stripeRow(orgA))!.accountId).toBe(accountId)
  })

  it('refuses collection until ENABLED, with one owner Task a day, and lets reads through', async () => {
    expect(await collectionRefusal(orgA)).toBe('The Stripe account is onboarding.')
    const provider = getBillingProvider(orgA)
    await expect(provider.createCustomer({ name: 'x', email: null, leasePayerId: 'lp' } as never)).rejects.toBeInstanceOf(
      CollectionRefusedError,
    )
    await expect(provider.addInvoiceItem({} as never)).rejects.toBeInstanceOf(CollectionRefusedError)
    expect(await tasks()).toHaveLength(1)
    // A read is not collection: the webhook and reconciliation keep working.
    expect(await provider.getOpenInvoices({ stripeCustomerId: `cus_${stamp}` })).not.toBeUndefined()
  })

  it("moves to RESTRICTED from account.updated with Stripe's reason, then ENABLED", async () => {
    await submitSimulatedOnboarding(accountId, false)
    expect(await stripeRow(orgA)).toMatchObject({ status: 'RESTRICTED', statusReason: 'requirements.past_due' })
    await submitSimulatedOnboarding(accountId, true)
    expect(await stripeRow(orgA)).toMatchObject({ status: 'ENABLED', statusReason: null })
    expect(await collectionRefusal(orgA)).toBeNull()
    expect(await startStripeOnboarding(orgA, URLS)).toMatchObject({ ok: false })
  })

  it('reads our row, not the simulator: a change Stripe never announced moves nothing (D-27)', async () => {
    await prisma.simulatedStripeAccount.update({ where: { accountId }, data: { chargesEnabled: false } })
    expect((await stripeRow(orgA))!.status).toBe('ENABLED')
    await prisma.simulatedStripeAccount.update({ where: { accountId }, data: { chargesEnabled: true } })
  })

  it('skips an account.updated older than the last one applied', async () => {
    const result = await processStripeEvent(orgA, {
      id: `evt_${stamp}_stale`,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000) - 3600,
      account: accountId,
      data: { object: { id: accountId, charges_enabled: false } },
    })
    expect(result.detail).toMatch(/older than the last update/)
    expect((await stripeRow(orgA))!.status).toBe('ENABLED')
  })

  it('records the platform fee from the PLATFORM endpoint, under the org whose account paid it, off the tenant ledger', async () => {
    const id = `evt_${stamp}_fee`
    const body = JSON.stringify({
      id,
      type: 'application_fee.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: `fee_${stamp}`, account: accountId, amount: 240, charge: `ch_${stamp}` } },
    })
    const header = stripeSignatureHeader({ rawBody: body, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) })
    const response = await platform(
      new Request('https://x.example.test/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': header }, body }),
    )
    expect(await response.json()).toMatchObject({ outcome: 'projected' })
    expect(await prisma.platformFee.findMany({ where: { orgId: orgA }, select: { amountCents: true, stripeChargeId: true } })).toEqual([
      { amountCents: 240, stripeChargeId: `ch_${stamp}` },
    ])
    expect(await prisma.ledgerEntry.count({ where: { orgId: orgA } })).toBe(0)
    await expect(prisma.platformFee.deleteMany({ where: { orgId: orgA } })).rejects.toThrow(/append-only/)
  })

  it("records the owner's paid $1 setup test once, off the tenant ledger, and step 9 reads it (R-291b)", async () => {
    const provider = getBillingProvider(orgA)
    const input = { staffUserId: 'staff_x', name: 'Owner', email: 'o@example.test', amountCents: 100, currency: 'usd', idempotencyKey: `setup-test:${orgA}:x` }
    const invoice = await provider.invoiceSetupTest(input)
    expect(invoice.hostedInvoiceUrl).toBe(`/settings/setup/simulated-invoice/${invoice.stripeInvoiceId}`)
    expect((await setupFacts(orgA)).testPayment).toBe(false)
    const simulator = new SimulatedBillingProvider(orgA)
    await simulator.paySetupTestInvoice(invoice.stripeInvoiceId, 100)
    await simulator.paySetupTestInvoice(invoice.stripeInvoiceId, 100)
    expect(await prisma.setupTestPayment.findMany({ where: { orgId: orgA }, select: { stripeInvoiceId: true, amountCents: true } })).toEqual([
      { stripeInvoiceId: invoice.stripeInvoiceId, amountCents: 100 },
    ])
    expect(await prisma.ledgerEntry.count({ where: { orgId: orgA } })).toBe(0)
    expect((await setupFacts(orgA)).testPayment).toBe(true)
    await expect(prisma.setupTestPayment.deleteMany({ where: { orgId: orgA } })).rejects.toThrow(/append-only/)
  })

  it('goes DISABLED on deauthorisation, raises the owner Task, and freezes collection; nothing is deleted', async () => {
    await prisma.task.deleteMany({ where: { propertyId } })
    await deauthorizeSimulated(accountId)
    expect(await stripeRow(orgA)).toMatchObject({ status: 'DISABLED', accountId })
    expect(await tasks()).toHaveLength(1)
    await expect(getBillingProvider(orgA).createPaymentIntent({} as never)).rejects.toBeInstanceOf(CollectionRefusedError)
    // An account.updated for the account we were disconnected from cannot reconnect it.
    await submitSimulatedOnboarding(accountId, true)
    expect((await stripeRow(orgA))!.status).toBe('DISABLED')
  })

  it('starts over on a new account after deauthorisation', async () => {
    expect((await startStripeOnboarding(orgA, URLS)).ok).toBe(true)
    const row = (await stripeRow(orgA))!
    expect(row.status).toBe('ONBOARDING')
    expect(row.accountId).not.toBe(accountId)
    await prisma.simulatedStripeAccount.deleteMany({ where: { accountId } })
  })
})
