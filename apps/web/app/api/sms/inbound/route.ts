import { verifyTwilioSignature } from '@rental/core/comms'
import { handleInboundSms } from '@/lib/comms/sms-intake.ts'

// Twilio's inbound-SMS webhook (MAINT-01, COMM-01, R-021).
//
// A PUBLIC, UNAUTHENTICATED ENDPOINT that writes to somebody's permanent
// conversation and can open a maintenance ticket in their name. Twilio has no
// session and no bearer token of ours to present, so the request signature is
// the entire authentication story - see verifyTwilioSignature.
//
// Everything below is arranged around two facts about webhooks:
//
//   The caller is not a browser and cannot be redirected, so failures are
//   status codes, never redirects to /login.
//
//   Twilio RETRIES on any non-2xx. That makes the response code a control
//   signal, not just a report: 200 means "stop", non-200 means "send it
//   again". Both directions matter and are used deliberately below.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The URL Twilio signed.
 *
 * Built from AUTH_URL - the same deliberately-not-derived-from-headers
 * constant R-003 uses for auth links - rather than from the request's own
 * Host header. Behind a proxy, `request.url` is the INTERNAL address
 * (http://localhost:3000/...) while Twilio signed the PUBLIC one, so a
 * signature check against `request.url` would fail every real request in
 * production and pass every one in development, which is the worst possible
 * split. Taking the host from an X-Forwarded-Host header instead would hand
 * an attacker control of a value inside the signature payload.
 */
function signedUrl(request: Request): string {
  const base = process.env.AUTH_URL
  if (!base) return request.url
  const incoming = new URL(request.url)
  return new URL(incoming.pathname + incoming.search, base).toString()
}

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    // Refuses everything when unset, exactly as the cron route does with
    // CRON_SECRET. A missing environment variable in a new deployment must
    // not turn a ticket-creating endpoint into an open one - and 503 rather
    // than 403 tells Twilio to retry, so messages sent during a
    // misconfiguration window are redelivered once it is fixed rather than
    // silently lost.
    console.error('[sms] TWILIO_AUTH_TOKEN is not set; refusing inbound webhook')
    return new Response('Not configured', { status: 503 })
  }

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  const valid = verifyTwilioSignature({
    authToken,
    url: signedUrl(request),
    params,
    signature: request.headers.get('x-twilio-signature'),
  })
  if (!valid) {
    // 403, and deliberately NOT retryable: a bad signature will still be bad
    // on redelivery, and a forged request should not earn itself repeat
    // attempts. Logged without the body - an unauthenticated caller's
    // payload is untrusted input, not something to write into our logs.
    console.error('[sms] rejected an inbound webhook with an invalid signature')
    return new Response('Forbidden', { status: 403 })
  }

  const from = params.From ?? ''
  const body = params.Body ?? ''
  const externalId = params.MessageSid ?? null

  if (!from) {
    // Signed by Twilio but missing the one field routing depends on. Not
    // retryable - it will be just as absent next time.
    return new Response('Missing From', { status: 400 })
  }

  try {
    const result = await handleInboundSms({
      from,
      body,
      receivedAt: new Date(),
      externalId,
    })
    // 204 with no body on every outcome INCLUDING unrouted. An unrouted
    // message is not a failure - it was recorded for a human to file
    // (R-017), and telling Twilio to retry would only produce duplicates of
    // something already saved. Empty rather than TwiML: an auto-reply is
    // COMM-07's, and R-029 owns the after-hours version, so this build must
    // not invent one here.
    console.info(`[sms] inbound ${externalId ?? '(no sid)'}: ${result.outcome}`)
    return new Response(null, { status: 204 })
  } catch (error) {
    // 500 IS the right answer here, because it makes Twilio retry - and a
    // transient database failure is exactly the case where redelivery
    // recovers a message that would otherwise be lost. `receiveInboundMessage`
    // is idempotent on MessageSid, so the retry cannot duplicate anything
    // that did commit.
    console.error('[sms] failed to handle an inbound message', error)
    return new Response('Error', { status: 500 })
  }
}
