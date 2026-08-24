import { timingSafeEqual } from 'node:crypto'
import { emailAddressOnly, extractReplyKey, htmlToText, stripQuotedReply } from '@rental/core/comms'
import { handleInboundEmail } from '@/lib/comms/email-intake.ts'
import { inboundEmailConfig } from '@/lib/comms/inbound-email-config.ts'
import type { InboundAttachment } from '@/lib/comms/inbound-attachments.ts'

// The inbound-email webhook (COMM-08, R-097a).
//
// A PUBLIC ENDPOINT THAT WRITES TO SOMEBODY'S PERMANENT CONVERSATION, so it
// is arranged the same way the Twilio one is (see that route's header for the
// full reasoning about retries and status codes as control signals).
//
// A SHARED SECRET RATHER THAN A SIGNATURE, and the difference is worth
// stating rather than glossing: Twilio signs its payload, so that route can
// verify the request came from Twilio. Inbound-email providers vary - some
// sign, most offer only a secret in the URL or a header - so this takes the
// lowest common denominator and compares it in constant time. It is weaker,
// and the mitigation is what the endpoint can DO: it files a message into an
// existing conversation, or into the unrouted queue. It cannot create a
// tenancy, move money, or say who somebody is.
//
// AND THAT IS THE HONEST LIMIT OF INBOUND EMAIL GENERALLY. A From: header is
// trivially forged, so a message routed by From: address is only as
// trustworthy as caller ID - which is exactly what SMS routing has lived with
// since R-017. Nothing here pretends otherwise, and nothing downstream treats
// an inbound message as authentication for anything.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/// One provider's payload, parsed in ONE PLACE (D-7's rule: no code outside
/// the boundary may assume a provider's shape). Every field is optional
/// because every provider names them differently, and a message that arrives
/// with only a From and a body is still a message.
interface InboundPayload {
  from?: string
  to?: string | string[]
  cc?: string | string[]
  recipient?: string
  subject?: string
  text?: string
  'body-plain'?: string
  html?: string
  messageId?: string
  'message-id'?: string
  /// R-097d. Base64 is the lowest common denominator across providers that
  /// post JSON; one that posts multipart would be parsed into this same
  /// shape in this same place (D-7's rule).
  attachments?: {
    filename?: string
    name?: string
    contentType?: string
    content_type?: string
    content?: string
  }[]
}

function addresses(...values: (string | string[] | undefined)[]): string[] {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
}

/// Decoded here, in the one place that knows a provider's shape, and handed
/// on as bytes. `Buffer.from(..., 'base64')` never throws on rubbish - it
/// returns what it could decode - so a mangled attachment becomes a short
/// buffer that the size and type checks then refuse, rather than an
/// exception that would cost the whole message.
function parseAttachments(payload: InboundPayload): InboundAttachment[] {
  return (payload.attachments ?? []).flatMap((raw) => {
    if (!raw.content) return []
    return [
      {
        fileName: raw.filename ?? raw.name ?? 'attachment',
        contentType: raw.contentType ?? raw.content_type ?? 'application/octet-stream',
        content: Buffer.from(raw.content, 'base64'),
      },
    ]
  })
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // Length has to match before `timingSafeEqual`, and comparing lengths
  // first leaks only the length - which is not the secret.
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.INBOUND_EMAIL_SECRET
  if (!expected) {
    // Refuses everything when unset, exactly as the SMS and cron routes do.
    // 503 rather than 403 so a provider retries once it is configured, since
    // a message lost during a misconfiguration window is a tenant who thinks
    // they told us something.
    console.error('[inbound-email] INBOUND_EMAIL_SECRET is not set; refusing webhook')
    return new Response('Not configured', { status: 503 })
  }

  const provided =
    request.headers.get('x-inbound-secret') ?? new URL(request.url).searchParams.get('secret') ?? ''
  if (!secretMatches(provided, expected)) {
    // 403, not 503: this one must NOT be retried. A wrong secret is wrong
    // every time, and telling the provider to try again turns a
    // misconfiguration into a loop.
    return new Response('Forbidden', { status: 403 })
  }

  let payload: InboundPayload
  try {
    payload = (await request.json()) as InboundPayload
  } catch {
    // Unparseable is 400 and final. Retrying it produces the same result.
    return new Response('Bad request', { status: 400 })
  }

  // NOT through `addresses()`: a From: header is one mailbox, so splitting it
  // on commas turns `"Vaughan, Dorothy" <d@example.com>` into `"Vaughan`.
  // `emailAddressOnly` is what makes the ordinary display-name form route at
  // all - see its own comment for the defect that reached production here.
  const from = payload.from ? emailAddressOnly(payload.from) : ''
  // R-097d. HTML-ONLY MAIL IS NOT AN EMPTY MESSAGE, and the first version of
  // this treated it as one: several mobile clients send no plain-text part
  // at all, so a tenant who typed a paragraph got a record saying they said
  // nothing. Plain text is still preferred where it exists - it is what the
  // sender's client thought the words were.
  const plain = payload.text ?? payload['body-plain'] ?? ''
  const body = plain.trim() !== '' ? plain : payload.html ? htmlToText(payload.html) : ''
  if (!from) {
    // No sender at all: nothing to file and nothing to triage, since even the
    // unrouted queue is keyed on who tried to make contact. Accepted rather
    // than retried - it will not get a From: header the second time.
    console.error('[inbound-email] payload had no From address; dropping')
    return new Response('Accepted', { status: 200 })
  }

  // Stripped once, and READ for the opt-out below from the stripped form -
  // almost every marketing email ever sent has "unsubscribe" in its footer,
  // so a reply quoting one would otherwise opt somebody out every time.
  const strippedBody = stripQuotedReply(body)
  const recipients = addresses(payload.to, payload.cc, payload.recipient)
  const inbound = inboundEmailConfig()
  const hasReplyKey =
    inbound != null &&
    extractReplyKey({
      recipients,
      inboundLocalPart: inbound.localPart,
      inboundDomain: inbound.domain,
    }) != null

  try {
    const result = await handleInboundEmail({
      from,
      // The quoted tail is cut rather than stored and hidden in the UI:
      // `Message` is append-only, so a third reply would otherwise store the
      // first two again, for ever, and the transcript a court reads becomes
      // mostly duplicates of itself.
      body: strippedBody,
      receivedAt: new Date(),
      // Providers retry; this makes a redelivery a no-op rather than a
      // second copy in somebody's history.
      externalId: payload.messageId ?? payload['message-id'] ?? null,
      recipients,
      attachments: parseAttachments(payload),
      // Proof they hit reply on something of ours, which is what stops every
      // "Thursday works" opening a maintenance ticket (R-097f).
      hasReplyKey,
    })
    return Response.json({ outcome: result.outcome }, { status: 200 })
  } catch (error) {
    // 500 so the provider retries: the message is real and losing it means a
    // tenant told us something we never recorded.
    console.error('[inbound-email] failed to file an inbound message', error)
    return new Response('Error', { status: 500 })
  }
}

