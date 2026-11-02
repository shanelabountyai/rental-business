import 'server-only'

import { type StripeEventEnvelope, verifyStripeSignature } from '@rental/core/billing'
import { processStripeEvent } from './webhook.ts'

// Stripe's webhook endpoint (D-11, R-034).
//
// PUBLIC BY NECESSITY, AUTHENTICATED BY SIGNATURE. Stripe has no credentials
// of ours to present, so the `Stripe-Signature` header is the entire
// authentication - and under D-11 this endpoint is where money enters the
// product's record. It is listed in route-guards.test.ts's PUBLIC_ROUTES
// with that reasoning attached, exactly like the Twilio one R-021 built.
//
// THE BODY IS READ AS RAW TEXT, BEFORE ANYTHING PARSES IT. Stripe signs the
// exact bytes it sent; re-serializing parsed JSON does not round-trip (key
// order, whitespace, number formatting), so a route that called
// `request.json()` first could never verify a genuine request. This is the
// one ordering constraint in the file and it is not negotiable.

// SHARED BY TWO ENDPOINTS (R-277a, D-316): the platform's own account (org
// #0's, D-362) and the Connect endpoint that receives every connected
// account's events. Each passes its own signing secret and its own answer to
// "whose event is this"; everything else is identical, so it lives once.

/**
 * `orgFor` names the org from the verified envelope, or returns a reason to
 * ignore it. Ignored events are acknowledged (200) without a claim, because
 * there is no org to claim under and Stripe retrying cannot produce one.
 */
export async function handleStripeWebhook(
  request: Request,
  secret: string | undefined,
  orgFor: (event: StripeEventEnvelope) => Promise<{ orgId: string } | { ignore: string }>,
): Promise<Response> {
  const rawBody = await request.text()

  const verdict = verifyStripeSignature({
    rawBody,
    header: request.headers.get('stripe-signature'),
    secret,
  })
  if (!verdict.ok) {
    // 400, and the reason is logged rather than returned. Stripe's dashboard
    // shows the status; telling an arbitrary caller WHICH check failed would
    // help somebody probing the endpoint tune their next attempt.
    console.warn(`[stripe] refused a webhook: ${verdict.reason}`)
    return new Response('Signature verification failed', { status: 400 })
  }

  let event: StripeEventEnvelope
  try {
    event = JSON.parse(rawBody) as StripeEventEnvelope
  } catch {
    return new Response('Malformed body', { status: 400 })
  }
  if (!event?.id || typeof event.type !== 'string') {
    return new Response('Not a Stripe event', { status: 400 })
  }

  const org = await orgFor(event)
  if ('ignore' in org) {
    console.warn(`[stripe] ignored ${event.id}: ${org.ignore}`)
    return Response.json({ received: true, outcome: 'ignored' })
  }

  try {
    const result = await processStripeEvent(org.orgId, event)
    // 200 for every outcome we have decided about, INCLUDING ignored and
    // duplicate. Stripe retries until it gets a 2xx, so returning an error
    // for "we deliberately did nothing with this" would have Stripe retry
    // forever and fill the dashboard with failures that are not failures.
    return Response.json({ received: true, outcome: result.outcome })
  } catch (error) {
    // A genuine failure on our side. 500 so Stripe DOES retry - the event
    // has not been handled, and its own claim row records that it got as far
    // as `received` and no further.
    console.error(`[stripe] failed to process ${event.id}`, error)
    return new Response('Processing failed', { status: 500 })
  }
}
