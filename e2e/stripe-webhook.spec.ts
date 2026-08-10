import { randomUUID } from 'node:crypto'
import { stripeSignatureHeader } from '@rental/core/billing'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The Stripe webhook endpoint, through real HTTP (D-11, R-034).
//
// THE SECURITY-CRITICAL TESTS ARE THE REFUSALS. Under D-11 this endpoint is
// where money enters the product's record, it is public by necessity, and
// the signature is the entire authentication. The algorithm itself is proved
// exhaustively offline in packages/core/billing/billing.test.ts; what only a
// real request proves is that the ROUTE actually applies it - over the raw
// body, before parsing - and refuses everything that fails.
//
// Mirrors e2e/sms-webhook.spec.ts, which R-021 built for the same shape of
// problem with Twilio.

const propertyIds: string[] = []
const tenantIds: string[] = []
const eventIds: string[] = []

/// The secret the running server is using. Set by playwright.config.ts for
/// both processes, exactly as it does for TWILIO_AUTH_TOKEN - see that
/// file's own comment for why a fixed fake is safe here.
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? ''

function signedRequest(body: unknown, options: { secret?: string; timestamp?: number } = {}) {
  const rawBody = JSON.stringify(body)
  return {
    rawBody,
    header: stripeSignatureHeader({
      rawBody,
      secret: options.secret ?? SECRET,
      timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
    }),
  }
}

async function post(
  request: import('@playwright/test').APIRequestContext,
  rawBody: string,
  header: string | null,
) {
  return request.post('/api/webhooks/stripe', {
    data: rawBody,
    headers: {
      'content-type': 'application/json',
      ...(header ? { 'stripe-signature': header } : {}),
    },
  })
}

/// A provisioned lease with a Stripe customer id the pipeline can resolve.
async function seedProvisionedLease() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Stripe LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Stripe House-${unique}`,
      addressLine1: '9 Webhook Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Wes', lastName: `Webhook-${unique}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      endsOn: new Date('2026-12-31'),
      rentCents: 175_000,
      activatedAt: new Date('2025-12-20T18:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  const stripeCustomerId = `cus_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
      stripeCustomerId,
      stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    },
  })
  return { lease, property, stripeCustomerId }
}

function paymentEvent(stripeCustomerId: string, amountPaid = 175_000) {
  const id = `evt_${randomUUID().replace(/-/g, '')}`
  eventIds.push(id)
  return {
    id,
    type: 'invoice.payment_succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `in_${randomUUID().slice(0, 12)}`,
        customer: stripeCustomerId,
        amount_paid: amountPaid,
        payment_intent: `pi_${randomUUID().slice(0, 12)}`,
      },
    },
  }
}

test.afterAll(async () => {
  await prisma.processedStripeEvent.deleteMany({ where: { stripeEventId: { in: eventIds } } })
  // LedgerEntry is append-only and its foreign keys are RESTRICT, so
  // everything a projected row points at stays. Only the roots that carry no
  // ledger reference are cleaned up, deactivated rather than deleted.
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('the signature is the authentication', () => {
  test('REFUSES an unsigned request', async ({ request }) => {
    const { rawBody } = signedRequest(paymentEvent('cus_whatever'))
    const response = await post(request, rawBody, null)
    expect(response.status()).toBe(400)
  })

  test('REFUSES a signature made with the wrong secret', async ({ request }) => {
    const { rawBody, header } = signedRequest(paymentEvent('cus_whatever'), {
      secret: 'whsec_an_attackers_guess',
    })
    const response = await post(request, rawBody, header)
    expect(response.status()).toBe(400)
  })

  test('REFUSES a body altered after signing', async ({ request }) => {
    // The attack this endpoint exists to stop: capture a genuine event,
    // change the amount, replay it.
    const { stripeCustomerId } = await seedProvisionedLease()
    const event = paymentEvent(stripeCustomerId, 100)
    const { rawBody, header } = signedRequest(event)

    const tampered = rawBody.replace('"amount_paid":100', '"amount_paid":100000000')
    expect(tampered).not.toBe(rawBody)

    const response = await post(request, tampered, header)
    expect(response.status()).toBe(400)
    expect(
      await prisma.processedStripeEvent.count({ where: { stripeEventId: event.id } }),
    ).toBe(0)
  })

  test('REFUSES a replay from outside the tolerance window', async ({ request }) => {
    const { stripeCustomerId } = await seedProvisionedLease()
    const event = paymentEvent(stripeCustomerId)
    const { rawBody, header } = signedRequest(event, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    })
    const response = await post(request, rawBody, header)
    expect(response.status()).toBe(400)
  })

  test('refuses a malformed signature header without a 500', async ({ request }) => {
    // An exception thrown from an auth check is a 500 where a clean refusal
    // belongs.
    const { rawBody } = signedRequest(paymentEvent('cus_whatever'))
    for (const bad of ['', 'garbage', 't=abc,v1=def', 'v1=onlythis']) {
      const response = await post(request, rawBody, bad)
      expect(response.status(), bad).toBe(400)
    }
  })
})

test.describe('the projection pipeline', () => {
  test('projects a signed payment into the ledger', async ({ request }) => {
    const { lease, stripeCustomerId } = await seedProvisionedLease()
    const event = paymentEvent(stripeCustomerId, 175_000)
    const { rawBody, header } = signedRequest(event)

    const response = await post(request, rawBody, header)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ received: true, outcome: 'projected' })

    const entries = await prisma.ledgerEntry.findMany({ where: { leaseId: lease.id } })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.amountCents).toBe(-175_000)
    expect(entries[0]!.stripeEventId).toBe(event.id)
  })

  test('a RETRY does not credit the tenant twice', async ({ request }) => {
    // Stripe retries until it gets a 2xx and does not promise exactly-once
    // delivery. LedgerEntry is append-only, so a double projection is money
    // nobody can correct by editing.
    const { lease, stripeCustomerId } = await seedProvisionedLease()
    const { rawBody, header } = signedRequest(paymentEvent(stripeCustomerId))

    const first = await post(request, rawBody, header)
    const second = await post(request, rawBody, header)

    expect(await first.json()).toMatchObject({ outcome: 'projected' })
    // 200, not an error: a duplicate is the guarantee working, and returning
    // a failure would have Stripe retry it forever.
    expect(second.status()).toBe(200)
    expect(await second.json()).toMatchObject({ outcome: 'duplicate' })

    expect(await prisma.ledgerEntry.count({ where: { leaseId: lease.id } })).toBe(1)
  })

  test('acknowledges an event it deliberately ignores', async ({ request }) => {
    // Anything we have decided about must return 2xx, or Stripe retries
    // forever and the dashboard fills with failures that are not failures.
    const id = `evt_${randomUUID().replace(/-/g, '')}`
    eventIds.push(id)
    const { rawBody, header } = signedRequest({
      id,
      type: 'customer.discount.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'di_1', customer: 'cus_1' } },
    })

    const response = await post(request, rawBody, header)
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ outcome: 'ignored' })

    const row = await prisma.processedStripeEvent.findUniqueOrThrow({
      where: { stripeEventId: id },
    })
    expect(row.outcome).toBe('ignored')
  })

  test('refuses a signed body that is not a Stripe event', async ({ request }) => {
    const { rawBody, header } = signedRequest({ hello: 'world' })
    const response = await post(request, rawBody, header)
    expect(response.status()).toBe(400)
  })
})
