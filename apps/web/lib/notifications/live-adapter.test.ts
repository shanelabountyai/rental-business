import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@rental/db'
import { saveOrgIntegration } from '@/lib/integrations/store.ts'
import { ChannelSendError } from './adapter.ts'
import { sandboxAddressFor } from './config.ts'
import { LiveChannelAdapter } from './live-adapter.ts'

// R-104. The drivers are two HTTPS calls each, so what is worth testing is
// exactly what a laptop cannot see when it points at the real providers: the
// body each one builds, the id each one hands back for webhook
// reconciliation, and what happens to the error shapes.
//
// The last of those is the one that matters. `failureCode` on a delivery row
// is the only thing a human ever sees about a refused message, and both
// providers answer 4xx with JSON rather than throwing - so a driver that
// forgot to read `response.ok` would record every rejection as a successful
// send with no id.

const adapter = new LiveChannelAdapter()

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/// Captures the one fetch each send makes.
function stubFetch(result: Response) {
  const fetchMock = vi.fn(async () => result)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const env = {
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM: 'notifications@example.test',
  TWILIO_ACCOUNT_SID: 'AC_test_sid',
  TWILIO_AUTH_TOKEN: 'test_token',
  TWILIO_MESSAGING_SERVICE_SID: 'MG_test_sid',
  AUTH_URL: 'https://app.example.test',
}

beforeEach(() => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the Resend driver', () => {
  it('posts a plain-text email and returns the id the webhook matches on', async () => {
    const fetchMock = stubFetch(response(200, { id: 'a1b2' }))

    const result = await adapter.send({
      channel: 'EMAIL',
      to: 'tenant@example.test',
      subject: 'Rent is due',
      body: 'Your rent of $1,650.00 is due on the 1st.',
      replyTo: 'hello+abc@inbound.example.test',
      orgId: 'org_0',
    })

    expect(result.externalId).toBe('a1b2')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'notifications@example.test',
      to: ['tenant@example.test'],
      subject: 'Rent is due',
      text: 'Your rent of $1,650.00 is due on the 1st.',
      reply_to: 'hello+abc@inbound.example.test',
    })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key')
  })

  it('sends a subject for a thread reply, which carries none', async () => {
    const fetchMock = stubFetch(response(200, { id: 'a1b2' }))
    await adapter.send({ channel: 'EMAIL', to: 'tenant@example.test', body: 'On my way.', orgId: 'org_0' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).subject).toBeTruthy()
  })

  it("raises Resend's own error name as the failure code", async () => {
    stubFetch(response(422, { name: 'validation_error', message: 'Invalid `to` field.' }))
    await expect(
      adapter.send({ channel: 'EMAIL', to: 'nonsense', subject: 's', body: 'b', orgId: 'org_0' }),
    ).rejects.toMatchObject({ name: 'ChannelSendError', code: 'validation_error' })
  })

  it('refuses an accepted email with no id rather than recording an unreconcilable send', async () => {
    stubFetch(response(200, {}))
    await expect(
      adapter.send({ channel: 'EMAIL', to: 'tenant@example.test', subject: 's', body: 'b', orgId: 'org_0' }),
    ).rejects.toBeInstanceOf(ChannelSendError)
  })
})

describe('the Twilio driver', () => {
  it('posts through the messaging service and wires the status callback', async () => {
    const fetchMock = stubFetch(response(201, { sid: 'SM123' }))

    const result = await adapter.send({
      channel: 'SMS',
      to: '+15125550123',
      body: 'Entry notice: Thursday, 9am.',
      orgId: 'org_0',
    })

    expect(result.externalId).toBe('SM123')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json')
    const form = new URLSearchParams(String(init.body))
    expect(Object.fromEntries(form)).toEqual({
      MessagingServiceSid: 'MG_test_sid',
      To: '+15125550123',
      Body: 'Entry notice: Thursday, 9am.',
      // R-040e's callback, which nothing could reach until this item.
      StatusCallback: 'https://app.example.test/api/sms/status',
    })
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('AC_test_sid:test_token').toString('base64')}`,
    )
  })

  it("raises Twilio's numeric code as the failure code", async () => {
    // 21610 is the STOP'd recipient - the code packages/core/comms already
    // reads on the status callback, so the two paths record it identically.
    stubFetch(response(400, { code: 21610, message: 'Unsubscribed recipient' }))
    await expect(
      adapter.send({ channel: 'SMS', to: '+15125550123', body: 'b', orgId: 'org_0' }),
    ).rejects.toMatchObject({ code: '21610' })
  })
})

describe('an unconfigured provider', () => {
  it('falls back to the console off a production deployment, so CI is unchanged', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const fetchMock = stubFetch(response(500, {}))

    const result = await adapter.send({
      channel: 'EMAIL',
      to: 'tenant@example.test',
      subject: 's',
      body: 'b',
      orgId: 'org_0',
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.externalId).toMatch(/^log_/)
    expect(await adapter.supports('EMAIL', 'org_0')).toBe(true)
  })

  it('is an unsupported channel ON a production deployment, never a logged lie', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '')

    expect(await adapter.supports('SMS', 'org_0')).toBe(false)
    // The other channel still goes out - the reason `supports` is per-channel.
    expect(await adapter.supports('EMAIL', 'org_0')).toBe(true)
    // PORTAL has no provider anywhere and is always deliverable.
    expect(await adapter.supports('PORTAL', 'org_0')).toBe(true)
  })
})

describe("an org's own credentials (R-275)", () => {
  const stamp = `integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let orgA = ''
  let orgB = ''

  beforeAll(async () => {
    orgA = (await prisma.organization.create({ data: { slug: `${stamp}-a`, name: `${stamp} A` } })).id
    orgB = (await prisma.organization.create({ data: { slug: `${stamp}-b`, name: `${stamp} B` } })).id
  })

  afterAll(async () => {
    await prisma.orgIntegration.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
  })

  it("never lends org #0's env credentials to another org in production", async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(await adapter.supports('SMS', orgB)).toBe(false)
    expect(await adapter.supports('EMAIL', orgB)).toBe(false)
    expect(await adapter.supports('SMS', 'org_0')).toBe(true)
  })

  it("sends on the org's own subaccount and token, not the env's", async () => {
    await saveOrgIntegration(orgA, 'TWILIO', {
      config: { accountSid: 'AC_org_a', messagingServiceSid: 'MG_org_a' },
      secret: 'org_a_token',
    })
    const fetchMock = stubFetch(response(201, { sid: 'SM_A' }))

    await adapter.send({ channel: 'SMS', to: '+15125550123', body: 'b', orgId: orgA })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_org_a/Messages.json')
    expect(new URLSearchParams(String(init.body)).get('MessagingServiceSid')).toBe('MG_org_a')
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('AC_org_a:org_a_token').toString('base64')}`,
    )
  })

  it('stores the secret sealed, never as plaintext', async () => {
    const row = await prisma.orgIntegration.findUniqueOrThrow({
      where: { orgId_provider: { orgId: orgA, provider: 'TWILIO' } },
    })
    expect(row.secret).toBeTruthy()
    expect(row.secret).not.toContain('org_a_token')
    expect(JSON.stringify(row.config)).not.toContain('org_a_token')
  })

  it("does not open org A's sealed token copied into org B's row", async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const a = await prisma.orgIntegration.findUniqueOrThrow({
      where: { orgId_provider: { orgId: orgA, provider: 'TWILIO' } },
    })
    await prisma.orgIntegration.create({
      data: { orgId: orgB, provider: 'TWILIO', config: a.config ?? {}, secret: a.secret },
    })
    expect(await adapter.supports('SMS', orgB)).toBe(false)
  })
})

describe('the sandbox redirect, once the drivers are real', () => {
  it('picks the address that suits the channel, so one pass exercises both', () => {
    const both = ['dev@example.test', '+15125550100']
    expect(sandboxAddressFor('EMAIL', both)).toBe('dev@example.test')
    expect(sandboxAddressFor('SMS', both)).toBe('+15125550100')
  })

  it('still redirects every channel to a single configured address', () => {
    // Unchanged from before there were two. A mismatched address fails at the
    // provider - visibly, on the delivery row - which is better than sending
    // the message on to the real tenant it was meant to be kept from.
    expect(sandboxAddressFor('SMS', ['dev@example.test'])).toBe('dev@example.test')
    expect(sandboxAddressFor('EMAIL', ['+15125550100'])).toBe('+15125550100')
  })

  it('is off when nothing is configured', () => {
    expect(sandboxAddressFor('EMAIL', [])).toBeNull()
  })
})
