import { createHmac, randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { blockedNumbers, isOptedOut } from '@/lib/comms/opt-out-store.ts'
import { saveOrgIntegration } from '@/lib/integrations/store.ts'
import { POST as inbound } from './route.ts'
import { POST as status } from '../status/route.ts'

// R-292a (PRD 10 §3.1 step 4, §3.2, §3.3). Each org's subaccount signs its
// webhooks with its own token, so the route has to know the org BEFORE it can
// verify - and it learns it from our number in the form. These drive the real
// routes with real signatures, as the status-route tests do, because the
// signature is the whole authentication story for a public endpoint.
//
// No STOP goes through the route here: it audits in the org, and an
// AuditLog row is append-only, so the org could never be cleaned up. The
// per-org opt-out is proven against rows written directly instead.

const ENV_TOKEN = 'test-env-token-r292a'
const ORG_TOKEN = 'test-org-token-r292a'
const URL_BASE = 'https://rental.example.test'

const stamp = `r292a-${randomUUID().slice(0, 8)}`
const random7 = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000)
/// The org's number. Random per run: the number is unique across orgs.
const ORG_NUMBER = `+1737${random7()}`
let orgA = ''
let previousToken: string | undefined
let previousAuthUrl: string | undefined
const strangers: string[] = []

beforeAll(async () => {
  previousToken = process.env.TWILIO_AUTH_TOKEN
  previousAuthUrl = process.env.AUTH_URL
  process.env.TWILIO_AUTH_TOKEN = ENV_TOKEN
  process.env.AUTH_URL = URL_BASE

  orgA = (await prisma.organization.create({ data: { slug: stamp, name: `${stamp} A` } })).id
  await saveOrgIntegration(orgA, 'TWILIO', {
    config: { accountSid: 'AC_r292a', messagingServiceSid: 'MG_r292a', phoneNumber: ORG_NUMBER },
    secret: ORG_TOKEN,
  })
})

afterAll(async () => {
  if (previousToken === undefined) delete process.env.TWILIO_AUTH_TOKEN
  else process.env.TWILIO_AUTH_TOKEN = previousToken
  if (previousAuthUrl === undefined) delete process.env.AUTH_URL
  else process.env.AUTH_URL = previousAuthUrl

  await prisma.unroutedMessage.deleteMany({ where: { orgId: orgA } })
  await prisma.smsOptOut.deleteMany({ where: { phone: { in: strangers } } })
  await prisma.orgIntegration.deleteMany({ where: { orgId: orgA } })
  await prisma.organization.deleteMany({ where: { id: orgA } })
})

function signed(path: string, params: Record<string, string>, token: string) {
  const url = `${URL_BASE}${path}`
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('')
  const body = new FormData()
  for (const [key, value] of Object.entries(params)) body.append(key, value)
  return new Request(url, {
    method: 'POST',
    headers: {
      'x-twilio-signature': createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64'),
    },
    body,
  })
}

function text(to: string, token: string) {
  const from = `+1555${random7()}`
  strangers.push(from)
  const params = { From: from, To: to, Body: `hello from ${stamp}`, MessageSid: `SM${randomUUID().replace(/-/g, '')}` }
  return { params, response: inbound(signed('/api/sms/inbound', params, token)) }
}

describe("an inbound text to an org's own number", () => {
  it("verifies with that org's token and files it in that org's queue", async () => {
    const { params, response } = text(ORG_NUMBER, ORG_TOKEN)
    expect((await response).status).toBe(204)

    const row = await prisma.unroutedMessage.findUniqueOrThrow({ where: { externalId: params.MessageSid } })
    expect(row.orgId).toBe(orgA)
  })

  it("REFUSES one signed with org #0's env token", async () => {
    // The forgery R-292a closes: before it, every webhook verified against
    // the env token, so whoever held org #0's token could post as any org.
    const { params, response } = text(ORG_NUMBER, ENV_TOKEN)
    expect((await response).status).toBe(403)
    expect(await prisma.unroutedMessage.findUnique({ where: { externalId: params.MessageSid } })).toBeNull()
  })

  it("REFUSES the org's token on a number it does not own", async () => {
    // An unprovisioned number is org #0's and verifies with the env token,
    // so org A's token cannot sign its way into org #0.
    const { response } = text(`+1737${random7()}`, ORG_TOKEN)
    expect((await response).status).toBe(403)
  })

  it('refuses, retryably, when the number names an org with no token to verify with', async () => {
    await saveOrgIntegration(orgA, 'TWILIO', { secret: null })
    try {
      const { response } = text(ORG_NUMBER, ORG_TOKEN)
      expect((await response).status).toBe(503)
    } finally {
      await saveOrgIntegration(orgA, 'TWILIO', { secret: ORG_TOKEN })
    }
  })
})

describe('a status callback from an org number', () => {
  it("cannot move another org's delivery row", async () => {
    const sid = `SM${randomUUID().replace(/-/g, '').slice(0, 30)}`
    const notification = await prisma.notification.create({
      data: {
        category: 'entry_notice',
        channel: 'SMS',
        recipientType: 'TENANT',
        recipientId: `tenant-${randomUUID().slice(0, 8)}`,
        toAddress: '+15125550100',
        templateKey: 'entry.notice',
        body: 'Somebody is coming to your home tomorrow.',
        idempotencyKey: `test:r292a:${randomUUID()}`,
        delivery: { create: { status: 'SENT', externalId: sid } },
      },
    })
    expect(notification.orgId).toBe('org_0')

    // Correctly signed by org A, naming org #0's MessageSid.
    const params = { MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30003', From: ORG_NUMBER, To: '+15125550100' }
    expect((await status(signed('/api/sms/status', params, ORG_TOKEN))).status).toBe(204)

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({ where: { notificationId: notification.id } })
    expect(delivery.status).toBe('SENT')
  })
})

describe('an opt-out is per org (PRD 10 §3.3)', () => {
  it("STOP to org A's number does not silence org #0's texts", async () => {
    const phone = `+1555${random7()}`
    strangers.push(phone)
    await prisma.smsOptOut.create({ data: { orgId: orgA, phone, source: 'INBOUND_KEYWORD', reason: 'STOP' } })

    expect(await isOptedOut(orgA, phone)).toBe(true)
    expect(await isOptedOut('org_0', phone)).toBe(false)
    expect(await blockedNumbers('org_0', [phone])).toEqual(new Set())

    // And both orgs can hold their own row for the same person.
    await prisma.smsOptOut.create({ data: { orgId: 'org_0', phone, source: 'INBOUND_KEYWORD', reason: 'STOP' } })
    expect(await isOptedOut('org_0', phone)).toBe(true)
  })
})
