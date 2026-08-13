import {
  isOptOutErrorCode,
  mapDeliveryStatus,
  shouldApplyStatus,
  verifyTwilioSignature,
} from '@rental/core/comms'
import { prisma } from '@rental/db'
import { recordOptOut } from '@/lib/comms/opt-out-store.ts'

// Twilio's delivery status callback (NOTIF-01, R-040e; D-38).
//
// WHAT THIS FIXES. `SENT` on a NotificationDelivery has meant *the provider
// accepted the message*. That is not the same claim as *it arrived*, and for
// `entry_notice` - legally significant, and a category a tenant is not
// permitted to switch off - the gap between those two sentences is the entire
// evidentiary value of the record. Until this route existed, a notice blocked
// by a carrier-level STOP was recorded as SENT and nothing anywhere said
// otherwise. A delivery record that can be silently false is the worst defect
// an evidence trail can have.
//
// A PUBLIC, UNAUTHENTICATED ENDPOINT, exactly like the inbound webhook next
// door: Twilio holds no credential of ours, so the request signature is the
// whole authentication story. The arrangement below is the same one that
// route arrived at, for the same reasons - see its comment.
//
// It is deliberately NOT wired to a sender yet. `provider.ts` still wires
// `LoggingChannelAdapter` (D-15), so nothing posts here in this build. It is
// written and tested now because the alternative is discovering the mapping
// is wrong on the day real messages start moving, and because
// `SmsOptOutSource.CARRIER_CALLBACK` would otherwise be a value nothing can
// produce.

function signedUrl(request: Request): string {
  const base = process.env.AUTH_URL
  if (!base) return request.url
  const incoming = new URL(request.url)
  return new URL(incoming.pathname + incoming.search, base).toString()
}

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    // 503, so Twilio retries: a callback lost during a misconfiguration
    // window is a delivery record that stays wrong for ever.
    console.error('[sms-status] TWILIO_AUTH_TOKEN is not set; refusing callback')
    return new Response('Not configured', { status: 503 })
  }

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  if (
    !verifyTwilioSignature({
      authToken,
      url: signedUrl(request),
      params,
      signature: request.headers.get('x-twilio-signature'),
    })
  ) {
    // Not retryable - a bad signature will still be bad on redelivery, and a
    // forged request should not earn itself repeat attempts. Logged without
    // the body: an unauthenticated caller's payload is untrusted input.
    console.error('[sms-status] rejected a callback with an invalid signature')
    return new Response('Forbidden', { status: 403 })
  }

  const externalId = params.MessageSid ?? ''
  const rawStatus = params.MessageStatus ?? ''
  const errorCode = params.ErrorCode ?? null
  const to = params.To ?? ''

  if (!externalId) return new Response('Missing MessageSid', { status: 400 })

  const status = mapDeliveryStatus(rawStatus)
  // `accepted`, `queued` and `sending` all describe a message still in
  // flight. 204 rather than 400: they are valid callbacks we simply have
  // nothing to record for, and telling Twilio otherwise would earn retries.
  if (status === null) return new Response(null, { status: 204 })

  try {
    // AN OPT-OUT IS RECORDED EVEN IF THE DELIVERY ROW CANNOT BE FOUND. The
    // block is a fact about the number, and it outranks our bookkeeping: a
    // callback whose MessageSid we cannot match still tells us we must stop
    // texting that number, and dropping it because of a join failure would
    // reintroduce the exact defect this route closes.
    if (isOptOutErrorCode(errorCode) && to) {
      await recordOptOut({
        phone: to,
        source: 'CARRIER_CALLBACK',
        reason: `twilio:${errorCode}`,
      })
    }

    const delivery = await prisma.notificationDelivery.findFirst({
      where: { externalId },
      select: { id: true, status: true },
    })
    if (!delivery) {
      // 204, not 404. The message may predate this route, or belong to
      // another environment sharing the account. Asking Twilio to retry
      // would not make the row appear.
      console.info(`[sms-status] no delivery for ${externalId} (${rawStatus})`)
      return new Response(null, { status: 204 })
    }

    if (!shouldApplyStatus(status, delivery.status)) {
      // Out-of-order or redelivered. Recorded as a no-op rather than an
      // error: this is the normal case, not a fault.
      return new Response(null, { status: 204 })
    }

    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status,
        deliveredAt: status === 'DELIVERED' || status === 'READ' ? new Date() : undefined,
        failedAt: status === 'FAILED' ? new Date() : undefined,
        failureCode: status === 'FAILED' ? (errorCode ?? 'unknown') : undefined,
      },
    })

    return new Response(null, { status: 204 })
  } catch (error) {
    // 500 makes Twilio retry, and every write above is idempotent - the
    // opt-out upserts, and `shouldApplyStatus` refuses to reapply a status
    // already recorded.
    console.error('[sms-status] failed to record a delivery status', error)
    return new Response('Error', { status: 500 })
  }
}
