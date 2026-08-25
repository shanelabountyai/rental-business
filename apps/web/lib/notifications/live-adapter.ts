import 'server-only'

import type { NotificationChannel } from '@rental/core/notifications'
import { ChannelSendError } from './adapter.ts'
import type { ChannelAdapter, OutboundMessage, SendResult } from './adapter.ts'
import { LoggingChannelAdapter } from './logging-adapter.ts'

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

/// Read per call, never captured at module load - the same reason
/// `notificationConfig()` is: a key added in the dashboard should take effect
/// on the next send, not the next cold start.
function resendConfig(): { apiKey: string; from: string } | null {
  const apiKey = env('RESEND_API_KEY')
  const from = env('RESEND_FROM')
  return apiKey && from ? { apiKey, from } : null
}

function twilioConfig(): { accountSid: string; authToken: string; serviceSid: string } | null {
  const accountSid = env('TWILIO_ACCOUNT_SID')
  const authToken = env('TWILIO_AUTH_TOKEN')
  const serviceSid = env('TWILIO_MESSAGING_SERVICE_SID')
  return accountSid && authToken && serviceSid
    ? { accountSid, authToken, serviceSid }
    : null
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
  config: { apiKey: string; from: string },
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
  config: { accountSid: string; authToken: string; serviceSid: string },
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
  supports(channel: NotificationChannel): boolean {
    // PORTAL has no provider: the notification IS the delivery, read in the
    // portal off the same log (R-018), so it is always supported.
    if (channel === 'PORTAL') return true
    if (!isProductionDeployment()) return true
    return channel === 'EMAIL' ? resendConfig() !== null : twilioConfig() !== null
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.channel === 'EMAIL') {
      const config = resendConfig()
      return config ? sendEmail(message, config) : logging.send(message)
    }
    if (message.channel === 'SMS') {
      const config = twilioConfig()
      return config ? sendSms(message, config) : logging.send(message)
    }
    return logging.send(message)
  }
}
