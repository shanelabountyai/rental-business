import { createHmac, timingSafeEqual } from 'node:crypto'

// Stripe webhook signature verification (R-034, D-11).
//
// THIS IS THE ONLY THING BETWEEN A PUBLIC URL AND "ANYONE CAN POST A
// PAYMENT TO ANY LEASE". Under D-11 Stripe is the source of truth for money
// and `LedgerEntry` is a projection of what Stripe tells us - so this
// endpoint is where money enters the product's record. Stripe has no
// credentials of ours to present, so the signature IS the authentication,
// and everything downstream trusts it completely.
//
// Stripe's scheme, from their documented algorithm:
//
//   1. The `Stripe-Signature` header is a comma-separated list of
//      `key=value` pairs: `t` is the unix timestamp the event was signed at,
//      and there may be SEVERAL `v1` entries - one per active endpoint
//      secret, which is how a secret is rotated without dropping events.
//   2. The signed payload is `${t}.${rawBody}` - the RAW body bytes, before
//      any JSON parse. Re-serializing parsed JSON does not round-trip
//      (key order, whitespace, number formatting), so a route that parses
//      first can never verify.
//   3. HMAC-SHA256 that string with the endpoint's signing secret, hex.
//   4. Compare against each `v1`, in constant time.
//   5. Reject anything older than a tolerance window - without it, a
//      captured-and-replayed request stays valid forever.
//
// Implemented here rather than pulled from the `stripe` SDK for exactly the
// reason R-021 gives for the Twilio one, which this deliberately mirrors: it
// is the security boundary of a public endpoint, it can be tested
// exhaustively offline against a known key, and D-15's refusal is aimed at
// untested outbound HTTP CLIENTS to providers we cannot call - a RECEIVER we
// can exercise completely with synthetic requests is the opposite case.
// Leaving it unbuilt until Stripe onboarding clears would mean shipping the
// endpoint later, with no test coverage, under time pressure.

/// Stripe's own default. Five minutes is long enough to survive a slow
/// network and a clock a little out of true, short enough that a captured
/// request is worthless by the time anybody notices it.
export const SIGNATURE_TOLERANCE_SECONDS = 300

export type SignatureRejection =
  | 'no_signature'
  | 'no_secret'
  | 'malformed_header'
  | 'timestamp_outside_tolerance'
  | 'no_matching_signature'

export type SignatureVerdict = { ok: true } | { ok: false; reason: SignatureRejection }

interface ParsedHeader {
  timestamp: number
  signatures: string[]
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null
  const signatures: string[] = []

  for (const part of header.split(',')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === 't') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return null
      timestamp = parsed
    } else if (key === 'v1') {
      // Several are legal and expected during a secret rotation.
      signatures.push(value)
    }
  }

  if (timestamp == null || signatures.length === 0) return null
  return { timestamp, signatures }
}

/**
 * Whether this request really came from Stripe.
 *
 * `rawBody` must be the bytes as received. A caller that has already parsed
 * the JSON cannot produce them again - see the note above - which is why the
 * route reads `request.text()` before anything else touches the body.
 *
 * Returns a reason rather than a bare boolean: the endpoint logs which check
 * failed, and "the timestamp was outside tolerance" and "the signature did
 * not match any secret" mean very different things when somebody is
 * debugging why Stripe's dashboard shows failed deliveries.
 */
export function verifyStripeSignature(args: {
  rawBody: string
  header: string | null
  secret: string | undefined
  /// Seconds since the epoch. Injected so the tolerance window is testable
  /// without waiting five minutes.
  nowSeconds?: number
  toleranceSeconds?: number
}): SignatureVerdict {
  if (!args.secret) return { ok: false, reason: 'no_secret' }
  if (!args.header) return { ok: false, reason: 'no_signature' }

  const parsed = parseHeader(args.header)
  if (!parsed) return { ok: false, reason: 'malformed_header' }

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = args.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS
  // Absolute difference, so a timestamp from the FUTURE is refused too. A
  // clock skew large enough to produce one is itself a reason not to trust
  // the request, and accepting it would widen the replay window by however
  // far ahead an attacker cares to claim to be.
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_outside_tolerance' }
  }

  const expected = createHmac('sha256', args.secret)
    .update(`${parsed.timestamp}.${args.rawBody}`, 'utf8')
    .digest('hex')
  const expectedBuffer = Buffer.from(expected, 'utf8')

  for (const candidate of parsed.signatures) {
    const provided = Buffer.from(candidate, 'utf8')
    // Length first: timingSafeEqual throws on a mismatch, and an exception
    // from an auth check is a 500 where a clean refusal belongs.
    if (
      provided.length === expectedBuffer.length &&
      timingSafeEqual(provided, expectedBuffer)
    ) {
      return { ok: true }
    }
  }

  return { ok: false, reason: 'no_matching_signature' }
}

/// Builds the header Stripe would send. Test-only in practice, and exported
/// so the tests cannot drift from the verifier by hand-rolling their own
/// idea of the format - if this is wrong, every test that uses it fails
/// alongside the thing it is testing.
export function stripeSignatureHeader(args: {
  rawBody: string
  secret: string
  timestamp: number
}): string {
  const signature = createHmac('sha256', args.secret)
    .update(`${args.timestamp}.${args.rawBody}`, 'utf8')
    .digest('hex')
  return `t=${args.timestamp},v1=${signature}`
}
