import { createHmac, timingSafeEqual } from 'node:crypto'

// Twilio webhook signature verification (R-021).
//
// THIS IS THE ONLY THING BETWEEN A PUBLIC URL AND "ANYONE CAN CREATE A
// TICKET ATTRIBUTED TO ANY TENANT". The inbound-SMS webhook has to be
// reachable without a session - Twilio has no credentials of ours to present
// - so the signature IS the authentication, and everything downstream
// (routing a message into somebody's permanent conversation, opening a
// maintenance ticket in their name) trusts it completely.
//
// Twilio's scheme, from their documented algorithm:
//
//   1. Take the full request URL exactly as Twilio called it, including
//      scheme, host, path and any query string.
//   2. Append every POST parameter, sorted by key, as key immediately
//      followed by value, with no separators at all.
//   3. HMAC-SHA1 that string with the account's auth token.
//   4. Base64 the result and compare to the X-Twilio-Signature header.
//
// Implemented here rather than pulled from the `twilio` SDK deliberately: it
// is fifteen lines, it is the security boundary of a public endpoint, and it
// can be tested exhaustively offline against a known key - which is exactly
// the distinction D-15 draws. D-15 refuses to ship an untested outbound
// HTTP CLIENT to a provider we cannot call; a RECEIVER we can exercise
// completely with synthetic requests is the opposite case, and leaving it
// unbuilt until 10DLC clears would mean shipping the endpoint later with no
// test coverage under time pressure.

/**
 * Whether `signature` is Twilio's signature for this request.
 *
 * Constant-time comparison, and a length check first because
 * `timingSafeEqual` throws on a mismatch - the length of a signature is not
 * a secret, but an exception thrown from an auth check is a 500 where a
 * clean `false` belongs.
 *
 * `url` must be the URL TWILIO CALLED, not the one the app thinks it is
 * serving. Behind a proxy those differ (http vs https, internal vs public
 * host) and the signature is computed over Twilio's version - see the route
 * for how it is reconstructed and why that reconstruction must not be taken
 * from an attacker-controlled header without care.
 */
export function verifyTwilioSignature(args: {
  authToken: string
  url: string
  params: Record<string, string>
  signature: string | null
}): boolean {
  if (!args.authToken || !args.signature) return false

  const payload =
    args.url +
    Object.keys(args.params)
      .sort()
      .map((key) => key + args.params[key])
      .join('')

  const expected = createHmac('sha1', args.authToken)
    .update(Buffer.from(payload, 'utf8'))
    .digest('base64')

  const provided = Buffer.from(args.signature, 'utf8')
  const computed = Buffer.from(expected, 'utf8')
  return (
    provided.length === computed.length && timingSafeEqual(provided, computed)
  )
}
