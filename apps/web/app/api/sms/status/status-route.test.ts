import { createHmac, randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from './route.ts'

// Twilio's delivery-status callback (R-040e, D-38).
//
// Driven through the real route function with real signatures, the way the
// Stripe webhook is tested: the signature check is the entire authentication
// story for a public endpoint, so a test that bypasses it is testing
// something else.
//
// Nothing posts here in this build - `provider.ts` still wires the logging
// adapter (D-15). That is exactly why it is tested now: the alternative is
// discovering the mapping is wrong on the day real messages start moving.

const AUTH_TOKEN = 'test-twilio-auth-token-r040e'
const URL_BASE = 'https://rental.example.test'

let propertyId: string
let entityId: string
const notificationIds: string[] = []
const phones: string[] = []

let previousToken: string | undefined
let previousAuthUrl: string | undefined

beforeAll(async () => {
  previousToken = process.env.TWILIO_AUTH_TOKEN
  previousAuthUrl = process.env.AUTH_URL
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN
  process.env.AUTH_URL = URL_BASE

  const stamp = `status-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: stamp,
      addressLine1: '7 Callback Road',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterAll(async () => {
  if (previousToken === undefined) delete process.env.TWILIO_AUTH_TOKEN
  else process.env.TWILIO_AUTH_TOKEN = previousToken
  if (previousAuthUrl === undefined) delete process.env.AUTH_URL
  else process.env.AUTH_URL = previousAuthUrl

  await prisma.smsOptOut.deleteMany({ where: { phone: { in: phones } } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/** A delivery row in a given state, with a MessageSid the callback can find. */
async function seedDelivery(status: 'SENT' | 'DELIVERED' | 'SUPPRESSED', externalId: string) {
  const notification = await prisma.notification.create({
    data: {
      category: 'entry_notice',
      channel: 'SMS',
      recipientType: 'TENANT',
      recipientId: `tenant-${randomUUID().slice(0, 8)}`,
      toAddress: '+15125550100',
      templateKey: 'entry.notice',
      body: 'Somebody is coming to your home tomorrow.',
      idempotencyKey: `test:status:${randomUUID()}`,
      propertyId,
      delivery: { create: { status, externalId } },
    },
    include: { delivery: true },
  })
  notificationIds.push(notification.id)
  return notification
}

function post(params: Record<string, string>, signature?: string) {
  const url = `${URL_BASE}/api/sms/status`
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('')
  const signed =
    signature ?? createHmac('sha1', AUTH_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64')

  const body = new FormData()
  for (const [key, value] of Object.entries(params)) body.append(key, value)

  return POST(
    new Request(url, {
      method: 'POST',
      headers: { 'x-twilio-signature': signed },
      body,
    }),
  )
}

describe('the delivery status callback', () => {
  it('REFUSES an unsigned or forged callback', async () => {
    // The whole authentication story for a public endpoint. 403 and NOT
    // retryable - a bad signature will still be bad on redelivery.
    const response = await post({ MessageSid: 'SM1', MessageStatus: 'delivered' }, 'not-a-signature')
    expect(response.status).toBe(403)
  })

  it('records delivery, which is the claim SENT could not make', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const notification = await seedDelivery('SENT', sid)

    const response = await post({ MessageSid: sid, MessageStatus: 'delivered', To: '+15125550100' })
    expect(response.status).toBe(204)

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('DELIVERED')
    expect(delivery.deliveredAt).not.toBeNull()
  })

  it('records a failure with the provider code', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const notification = await seedDelivery('SENT', sid)

    await post({
      MessageSid: sid,
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
      To: '+15125550100',
    })

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('FAILED')
    expect(delivery.failureCode).toBe('30003')
    expect(delivery.failedAt).not.toBeNull()
  })

  it('OPTS THE NUMBER OUT when the carrier says they replied STOP', async () => {
    // The common case: the carrier absorbs the keyword and never forwards it,
    // so this - not the inbound webhook - is how we usually find out.
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const phone = `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`
    phones.push(phone)
    await seedDelivery('SENT', sid)

    await post({ MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '21610', To: phone })

    const optOut = await prisma.smsOptOut.findUnique({ where: { phone } })
    expect(optOut).not.toBeNull()
    expect(optOut?.source).toBe('CARRIER_CALLBACK')
    expect(optOut?.revokedAt).toBeNull()
  })

  it('does NOT opt anybody out for an unreachable handset', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const phone = `+1512556${String(Math.floor(Math.random() * 9000) + 1000)}`
    phones.push(phone)
    await seedDelivery('SENT', sid)

    await post({ MessageSid: sid, MessageStatus: 'failed', ErrorCode: '30003', To: phone })

    expect(await prisma.smsOptOut.findUnique({ where: { phone } })).toBeNull()
  })

  it('REFUSES to walk a record backwards when callbacks arrive out of order', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const notification = await seedDelivery('DELIVERED', sid)

    await post({ MessageSid: sid, MessageStatus: 'sent', To: '+15125550100' })

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('DELIVERED')
  })

  it('never overwrites a SUPPRESSED row, which describes a decision not to send', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const notification = await seedDelivery('SUPPRESSED', sid)

    await post({ MessageSid: sid, MessageStatus: 'delivered', To: '+15125550100' })

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('SUPPRESSED')
  })

  it('accepts a callback for a message it cannot match, without asking for a retry', async () => {
    // The message may predate this route or belong to another environment
    // sharing the Twilio account. Retrying would not make the row appear.
    const response = await post({
      MessageSid: `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`,
      MessageStatus: 'delivered',
    })
    expect(response.status).toBe(204)
  })

  it('ignores the statuses that only mean "still in flight"', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const notification = await seedDelivery('SENT', sid)

    for (const status of ['accepted', 'queued', 'sending']) {
      expect((await post({ MessageSid: sid, MessageStatus: status })).status).toBe(204)
    }

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('SENT')
  })
})
