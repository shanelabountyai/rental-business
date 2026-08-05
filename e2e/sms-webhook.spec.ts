import { createHmac, randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The inbound-SMS webhook end to end (MAINT-01, COMM-01, R-021).
//
// This is the only PUBLIC, UNAUTHENTICATED write endpoint in the product, so
// the tests that matter most are the ones that try to abuse it: a forged
// signature, a tampered body, a tampered sender. Each must be refused
// through the real HTTP stack, not merely by the pure function that the unit
// tests already cover.
//
// TWILIO_AUTH_TOKEN is set on the dev server by playwright.config's own env
// (see below) - without it the route correctly refuses everything, which
// would make these tests pass for the wrong reason. The 503 case is asserted
// explicitly rather than left implicit.

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? ''

const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const unroutedPhones: string[] = []

async function seedTenant(phone: string) {
  const entity = await prisma.legalEntity.create({
    data: { name: `Sms LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Sms House-${randomUUID().slice(0, 8)}`,
      addressLine1: '8 Signal Street',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  const tenant = await prisma.tenant.create({
    data: { firstName: 'Text', lastName: `Sender-${randomUUID().slice(0, 6)}`, phone },
  })
  tenantIds.push(tenant.id)

  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: `U-${randomUUID().slice(0, 6)}`,
      status: 'OCCUPIED',
    },
  })
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
  return { tenant, property }
}

/// Signs exactly as Twilio does. `url` must match what the route
/// reconstructs from AUTH_URL, not what the test dialled.
function twilioSignature(url: string, params: Record<string, string>): string {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('')
  return createHmac('sha1', AUTH_TOKEN)
    .update(Buffer.from(payload, 'utf8'))
    .digest('base64')
}

/**
 * The URL the ROUTE will reconstruct, which is what it verifies against.
 *
 * Built from Playwright's own `baseURL`, deliberately NOT from
 * `process.env.AUTH_URL`. playwright.config sets the dev server's AUTH_URL to
 * exactly baseURL, so those agree by construction - whereas this test
 * process's AUTH_URL comes from .env.local and is whatever port the developer
 * happens to have configured. The first draft used the env var and passed
 * only because both happened to be :3000; running the suite on another port
 * (to dodge a port clash with another project) made every signed request
 * 403, which is the route being right and the test being wrong.
 */
function signedUrl(baseURL: string): string {
  return new URL('/api/sms/inbound', baseURL).toString()
}

test.afterAll(async () => {
  await prisma.eventConsumption.deleteMany({
    where: { event: { propertyId: { in: propertyIds } } },
  })
  await prisma.outboxEvent.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.unroutedMessage.deleteMany({
    where: { fromAddress: { in: unroutedPhones } },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('signature verification', () => {
  test.skip(
    !AUTH_TOKEN,
    'TWILIO_AUTH_TOKEN is not set for the test server, so the route correctly refuses everything and these would pass for the wrong reason.',
  )

  test('accepts a correctly signed text and opens a ticket', async ({
    request,
    baseURL,
  }) => {
    const phone = `+1512555${Math.floor(1000 + Math.random() * 8999)}`
    const { tenant } = await seedTenant(phone)

    const params = {
      From: phone,
      Body: 'The bathroom tap will not stop running',
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
    }
    const response = await request.post('/api/sms/inbound', {
      form: params,
      headers: {
        'x-twilio-signature': twilioSignature(signedUrl(baseURL!), params),
      },
    })
    expect(response.status()).toBe(204)

    await expect
      .poll(() => prisma.ticket.count({ where: { tenantId: tenant.id } }), {
        timeout: 10_000,
      })
      .toBe(1)

    const ticket = await prisma.ticket.findFirstOrThrow({
      where: { tenantId: tenant.id },
    })
    ticketIds.push(ticket.id)
    expect(ticket.source).toBe('SMS')
    expect(ticket.description).toContain('The bathroom tap will not stop running')

    // And it threaded (COMM-01) - one conversation, not a ticket in isolation.
    const message = await prisma.message.findFirst({
      where: { externalId: params.MessageSid },
    })
    expect(message).not.toBeNull()
    expect(message?.direction).toBe('INBOUND')
  })

  test('REFUSES a forged signature with 403 and writes nothing', async ({
    request,
  }) => {
    const phone = `+1512555${Math.floor(1000 + Math.random() * 8999)}`
    const { tenant } = await seedTenant(phone)

    const response = await request.post('/api/sms/inbound', {
      form: {
        From: phone,
        Body: 'Let me in',
        MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
      },
      headers: { 'x-twilio-signature': 'obviously-not-a-real-signature' },
    })
    expect(response.status()).toBe(403)

    // 403 is deliberately NOT retryable - a bad signature stays bad, and a
    // forged request should not earn repeat attempts.
    expect(await prisma.ticket.count({ where: { tenantId: tenant.id } })).toBe(0)
  })

  test('REFUSES a request with no signature header at all', async ({ request }) => {
    const response = await request.post('/api/sms/inbound', {
      form: { From: '+15125550000', Body: 'hello', MessageSid: 'SMnope' },
    })
    expect(response.status()).toBe(403)
  })

  test('REFUSES a body tampered with after signing', async ({
    request,
    baseURL,
  }) => {
    // The realistic attack: replay a genuinely-signed request with the words
    // swapped. The signature covers every parameter, so it must not verify.
    const phone = `+1512555${Math.floor(1000 + Math.random() * 8999)}`
    const { tenant } = await seedTenant(phone)

    const original = {
      From: phone,
      Body: 'The porch light is out',
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
    }
    const signature = twilioSignature(signedUrl(baseURL!), original)

    const response = await request.post('/api/sms/inbound', {
      form: { ...original, Body: 'Please mail my deposit to a new address' },
      headers: { 'x-twilio-signature': signature },
    })
    expect(response.status()).toBe(403)
    expect(await prisma.ticket.count({ where: { tenantId: tenant.id } })).toBe(0)
  })

  test('REFUSES a sender tampered with after signing', async ({
    request,
    baseURL,
  }) => {
    // The most dangerous tamper: From is what decides WHOSE conversation and
    // WHOSE ticket this becomes.
    const phone = `+1512555${Math.floor(1000 + Math.random() * 8999)}`
    const victimPhone = `+1512555${Math.floor(1000 + Math.random() * 8999)}`
    await seedTenant(phone)
    const { tenant: victim } = await seedTenant(victimPhone)

    const original = {
      From: phone,
      Body: 'hello',
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
    }
    const signature = twilioSignature(signedUrl(baseURL!), original)

    const response = await request.post('/api/sms/inbound', {
      form: { ...original, From: victimPhone },
      headers: { 'x-twilio-signature': signature },
    })
    expect(response.status()).toBe(403)
    expect(await prisma.ticket.count({ where: { tenantId: victim.id } })).toBe(0)
  })
})

test.describe('handling a signed message', () => {
  test.skip(!AUTH_TOKEN, 'TWILIO_AUTH_TOKEN is not set for the test server.')

  test('accepts an unroutable text with 204 rather than asking for a retry', async ({
    request,
    baseURL,
  }) => {
    // An unrouted message is NOT a failure - it was recorded for a human
    // (R-017). Telling Twilio to retry would only duplicate what is saved.
    const unknown = `+1512999${Math.floor(1000 + Math.random() * 8999)}`
    unroutedPhones.push(unknown)

    const params = {
      From: unknown,
      Body: 'is this the landlord?',
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
    }
    const response = await request.post('/api/sms/inbound', {
      form: params,
      headers: {
        'x-twilio-signature': twilioSignature(signedUrl(baseURL!), params),
      },
    })
    expect(response.status()).toBe(204)

    await expect
      .poll(
        () => prisma.unroutedMessage.count({ where: { fromAddress: unknown } }),
        { timeout: 10_000 },
      )
      .toBe(1)
  })

  test('is idempotent on redelivery of the same MessageSid', async ({
    request,
    baseURL,
  }) => {
    const phone = `+1512555${Math.floor(1000 + Math.random() * 8999)}`
    const { tenant } = await seedTenant(phone)

    const params = {
      From: phone,
      Body: 'No hot water since this morning',
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
    }
    const headers = {
      'x-twilio-signature': twilioSignature(signedUrl(baseURL!), params),
    }

    const first = await request.post('/api/sms/inbound', { form: params, headers })
    const second = await request.post('/api/sms/inbound', { form: params, headers })
    expect(first.status()).toBe(204)
    expect(second.status()).toBe(204)

    await expect
      .poll(() => prisma.ticket.count({ where: { tenantId: tenant.id } }), {
        timeout: 10_000,
      })
      .toBe(1)
    const tickets = await prisma.ticket.findMany({ where: { tenantId: tenant.id } })
    ticketIds.push(...tickets.map((t) => t.id))

    expect(
      await prisma.message.count({ where: { externalId: params.MessageSid } }),
    ).toBe(1)
  })

  test('rejects a signed request missing From, without retrying', async ({
    request,
    baseURL,
  }) => {
    const params = { Body: 'anonymous', MessageSid: `SM${randomUUID()}` }
    const response = await request.post('/api/sms/inbound', {
      form: params,
      headers: {
        'x-twilio-signature': twilioSignature(signedUrl(baseURL!), params),
      },
    })
    // 400, not 500 - it will be just as absent on redelivery.
    expect(response.status()).toBe(400)
  })
})

test.describe('when TWILIO_AUTH_TOKEN is not configured', () => {
  test.skip(
    Boolean(AUTH_TOKEN),
    'The token IS configured for this run, so the unconfigured path cannot be exercised here.',
  )

  test('refuses with 503 so Twilio retries once it is configured', async ({
    request,
  }) => {
    // 503 rather than 403 on purpose: messages sent during a
    // misconfiguration window are redelivered once it is fixed rather than
    // silently lost.
    const response = await request.post('/api/sms/inbound', {
      form: { From: '+15125550000', Body: 'hello', MessageSid: 'SMx' },
      headers: { 'x-twilio-signature': 'anything' },
    })
    expect(response.status()).toBe(503)
  })
})
