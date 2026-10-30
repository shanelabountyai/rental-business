import 'server-only'

import { normalizePhone } from '@rental/core/comms'
import type { NotificationChannel } from '@rental/core/notifications'
import { ChannelSendError } from './adapter.ts'
import type { ChannelAdapter, OutboundMessage, SendResult } from './adapter.ts'
import { LoggingChannelAdapter } from './logging-adapter.ts'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { orgIdForTwilioNumber, orgIntegration } from '@/lib/integrations/store.ts'

// The real drivers (R-104, closing D-15's seam). Resend for email, Twilio for
// SMS, behind the one `ChannelAdapter` interface `deliverOverChannel` already
// calls - nothing else in the product changes, which was the point of the
// seam.
//
// NO SDKs. Each provider is one HTTPS POST with a documented body and a
// documented error shape; `resend` and `twilio` would add two dependency
// trees, two release cadences and two ways to be surprised, to save about
// fifteen lines each. `fetch` is in the runtime.
//
// AN UNCONFIGURED CHANNEL FALLS BACK TO THE CONSOLE, EXCEPT IN PRODUCTION.
// Locally and in CI there is no API key and there never will be, so email and
// SMS behave exactly as they did before this item: recorded, logged, SENT.
// On a production deployment that fallback would be a lie - a delivery row
// saying SENT for a message that reached nobody, which is the single failure
// this engine exists to make impossible - so there `supports()` answers false
// and the engine records SUPPRESSED / `unsupported_channel` instead. That is
// the channel-missing path the engine was already written for, and it is
// visible in the record rather than silent.
//
// `VERCEL_ENV`, not `NODE_ENV`: the e2e suite runs a PRODUCTION BUILD
// (CLAUDE.md, R-042), so `NODE_ENV === 'production'` is true on a laptop with
// no keys and would turn the whole suite's notifications off.

const TIMEOUT_MS = 10_000

/// Email needs one and a thread reply carries none - `sendThreadMessage` sends
/// a human's words with no subject at all, because SMS has no such field.
const DEFAULT_SUBJECT = 'New message'

const logging = new LoggingChannelAdapter()

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

// WHOSE CREDENTIALS (R-275). An org's own `OrgIntegration` row first. Org #0
// with no row sends on the env vars, which are its credentials and nobody
// else's: any other org with no row has no sender, so org #1 can never text
// from org #0's number. Read per call, never captured at module load - the
// same reason `notificationConfig()` is: a key added in the dashboard (or a
// row provisioned by R-292/R-293) takes effect on the next send.
//
// ponytail: a row is used whatever its `status`. R-292b adds the 10DLC
// campaign gate and R-293 the domain-verified gate on top of this.
type ResendConfig = { apiKey: string; from: string }
type TwilioConfig = { accountSid: string; authToken: string; serviceSid: string }

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// THE PLATFORM (orgId null, R-302b) sends on the env vars too: they are the
// operator's account. ponytail: it shares org #0's `from`; add a
// PLATFORM_RESEND_FROM when org #0 stops being the operator's own business.
async function resendConfig(orgId: string | null): Promise<ResendConfig | null> {
  const row = orgId === null ? null : await orgIntegration(orgId, 'RESEND')
  if (row) {
    const from = configString(row.config, 'from')
    return row.secret && from ? { apiKey: row.secret, from } : null
  }
  if (orgId !== null && orgId !== DEFAULT_ORG_ID) return null
  const apiKey = env('RESEND_API_KEY')
  const from = env('RESEND_FROM')
  return apiKey && from ? { apiKey, from } : null
}

async function twilioConfig(orgId: string | null): Promise<TwilioConfig | null> {
  if (orgId === null) return null
  const row = await orgIntegration(orgId, 'TWILIO')
  if (row) {
    const accountSid = configString(row.config, 'accountSid')
    const serviceSid = configString(row.config, 'messagingServiceSid')
    return row.secret && accountSid && serviceSid
      ? { accountSid, authToken: row.secret, serviceSid }
      : null
  }
  if (orgId !== DEFAULT_ORG_ID) return null
  const accountSid = env('TWILIO_ACCOUNT_SID')
  const authToken = env('TWILIO_AUTH_TOKEN')
  const serviceSid = env('TWILIO_MESSAGING_SERVICE_SID')
  return accountSid && authToken && serviceSid
    ? { accountSid, authToken, serviceSid }
    : null
}

/**
 * Which org a Twilio webhook belongs to, and the token it must verify with
 * (R-292a, PRD 10 §3.1 step 4). Keyed on OUR number in the signed form -
 * `To` inbound, `From` on a status callback - because nothing else in an
 * unverified request can say which token to check it against. Picking the
 * token from an unverified field is safe: a forger who names org A's number
 * still has to sign with org A's token.
 *
 * A provisioned number names its org and its sealed subaccount token. Any
 * other number is org #0's on the env token, and only while org #0 has no
 * row - the same rule `twilioConfig` sends by (D-362). Null means there is no
 * token to verify with, and the route refuses.
 */
export async function twilioWebhookAccount(
  number: string,
): Promise<{ orgId: string; authToken: string } | null> {
  const e164 = normalizePhone(number)
  const orgId = e164 ? await orgIdForTwilioNumber(e164) : null
  if (orgId) {
    const row = await orgIntegration(orgId, 'TWILIO')
    return row?.secret ? { orgId, authToken: row.secret } : null
  }
  if (await orgIntegration(DEFAULT_ORG_ID, 'TWILIO')) return null
  const authToken = env('TWILIO_AUTH_TOKEN')
  return authToken ? { orgId: DEFAULT_ORG_ID, authToken } : null
}

function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

/// Both providers answer JSON on success and on error. A body that will not
/// parse is a proxy or an outage page, not the provider - hence the null.
async function parse(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null
}

function str(payload: Record<string, unknown> | null, key: string): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' ? value : undefined
}

async function sendEmail(
  message: OutboundMessage,
  config: ResendConfig,
): Promise<SendResult> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [message.to],
      subject: message.subject ?? DEFAULT_SUBJECT,
      // TEXT ONLY, deliberately. Every template in this product renders plain
      // text (packages/core/notifications/templates.ts), and an HTML body
      // built by wrapping that text in tags is a new, untested rendering of
      // legally significant wording.
      text: message.body,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const payload = await parse(response)
  if (!response.ok) {
    // Resend's error shape is { statusCode, name, message }. `name` is the
    // stable machine code ("validation_error", "rate_limit_exceeded"), which
    // is what a later retry policy branches on.
    throw new ChannelSendError(
      str(payload, 'name') ?? `http_${response.status}`,
      str(payload, 'message') ?? `Resend returned ${response.status}`,
    )
  }

  // The id the Resend webhook (R-054) matches deliveries on. Absent means a
  // response we do not understand, and a delivery we could never reconcile.
  const id = str(payload, 'id')
  if (!id) throw new ChannelSendError('no_id', 'Resend accepted the email but returned no id')
  return { externalId: id }
}

async function sendSms(
  message: OutboundMessage,
  config: TwilioConfig,
): Promise<SendResult> {
  const form = new URLSearchParams({
    MessagingServiceSid: config.serviceSid,
    To: message.to,
    Body: message.body,
  })

  // Wiring the callback R-040e built and could not reach. Without it `SENT`
  // goes on meaning only "Twilio accepted it", which for `entry_notice` is
  // the difference D-38 exists to record. Skipped when AUTH_URL is unset
  // rather than guessed: a callback URL derived from anything else would
  // point at a host we do not control.
  const base = env('AUTH_URL')
  if (base) form.set('StatusCallback', new URL('/api/sms/status', base).toString())

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )

  const payload = await parse(response)
  if (!response.ok) {
    // Twilio's numeric code is the stable one and the one already understood
    // elsewhere: `isOptOutErrorCode` in packages/core/comms reads exactly
    // these on the status callback. Stringified because failureCode is text.
    const code = payload?.code
    throw new ChannelSendError(
      typeof code === 'number' || typeof code === 'string' ? String(code) : `http_${response.status}`,
      str(payload, 'message') ?? `Twilio returned ${response.status}`,
    )
  }

  const sid = str(payload, 'sid')
  if (!sid) throw new ChannelSendError('no_sid', 'Twilio accepted the message but returned no sid')
  return { externalId: sid }
}

export class LiveChannelAdapter implements ChannelAdapter {
  async supports(channel: NotificationChannel, orgId: string | null): Promise<boolean> {
    // PORTAL has no provider: the notification IS the delivery, read in the
    // portal off the same log (R-018), so it is always supported.
    if (channel === 'PORTAL') return true
    if (!isProductionDeployment()) return true
    return channel === 'EMAIL'
      ? (await resendConfig(orgId)) !== null
      : (await twilioConfig(orgId)) !== null
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.channel === 'EMAIL') {
      const config = await resendConfig(message.orgId)
      return config ? sendEmail(message, config) : logging.send(message)
    }
    if (message.channel === 'SMS') {
      const config = await twilioConfig(message.orgId)
      return config ? sendSms(message, config) : logging.send(message)
    }
    return logging.send(message)
  }
}
