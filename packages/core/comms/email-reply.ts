// Inbound email threading (COMM-08, R-097a). Pure - no database, no Next.js.
//
// ==========================================================================
// THE ROUTING DECISION IS ALREADY BUILT AND IS NOT RE-DECIDED HERE.
// `decideRoute` refuses to guess between candidates, and its own header
// explains why at length: a refusal costs somebody thirty seconds of triage,
// a wrong match files one tenant's conversation into another's permanent
// record with an audit trail saying it was legitimate. Email changes none of
// that. What this file adds is the two things email has that SMS does not.
//
// A REPLY KEY IN THE ADDRESS, which is the only high-confidence match there
// is. `hello+k7x2...@inbound.example.com` names the THREAD, so it resolves
// the ambiguity that would otherwise send a message to the unrouted queue -
// a tenant with tenancies at two properties replying to an email about one
// of them is exactly the AMBIGUOUS case, and the key says which.
//
// AND A QUOTED TAIL, which SMS does not have. Every reply carries the entire
// prior conversation beneath it, and `Message` is append-only - so without
// stripping, the third reply in a thread stores the first two again, and the
// transcript a court reads is mostly duplicates of itself.
//
// SUBJECT LINES ARE NEVER USED FOR MATCHING, deliberately. Subject-based
// threading is how mail systems put an unrelated "Re: Maintenance" into
// somebody else's conversation, and it is the single commonest way this
// class of feature leaks.
// ==========================================================================

/// Opaque, URL-and-address safe, and long enough that guessing one is not a
/// route in. Not a secret in the credential sense - it names a conversation,
/// it never authenticates anybody, and the identity of an inbound email is
/// only ever as good as the From: header, which is to say weak. Same posture
/// SMS routing already lives with for caller ID.
export const REPLY_KEY_LENGTH = 24

const KEY_PATTERN = /^[a-z0-9]{16,64}$/

export function isReplyKey(value: string): boolean {
  return KEY_PATTERN.test(value)
}

/**
 * The address a reply should be sent to.
 *
 * PLUS-ADDRESSING (RFC 5233 sub-addressing), because it needs no per-thread
 * mailbox and every provider that offers inbound routing supports it. The
 * cost, named: a handful of corporate mail systems strip `+tags` on the way
 * out. When that happens the reply still arrives, and still routes by
 * From: address - it just loses the thread precision, which is a graceful
 * degradation rather than a failure.
 */
export function replyAddress(input: {
  inboundLocalPart: string
  inboundDomain: string
  replyKey: string
}): string {
  return `${input.inboundLocalPart}+${input.replyKey}@${input.inboundDomain}`
}

/**
 * The reply key an inbound message was addressed to, if any.
 *
 * Reads every recipient header the provider gives us - a reply that CC'd the
 * office and To'd a colleague still carries our address somewhere, and taking
 * only `To:` would drop it. Case-insensitive on the domain, because mail
 * systems rewrite it freely.
 */
export function extractReplyKey(input: {
  recipients: readonly string[]
  inboundLocalPart: string
  inboundDomain: string
}): string | null {
  const local = input.inboundLocalPart.toLowerCase()
  const domain = input.inboundDomain.toLowerCase()

  for (const raw of input.recipients) {
    // `Name <addr@example.com>` as well as a bare address.
    const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase()
    const [localPart, host] = address.split('@')
    if (!localPart || host !== domain) continue
    const [base, ...tagParts] = localPart.split('+')
    if (base !== local) continue
    // `a+b+c` is one tag containing a plus, not two tags. Rejoining rather
    // than taking [1] means a key is never silently truncated.
    const tag = tagParts.join('+')
    if (isReplyKey(tag)) return tag
  }
  return null
}

/// Lines that begin a quoted tail. Deliberately conservative: each of these
/// is a line whose presence is unambiguous, because the cost of cutting too
/// eagerly is losing what the tenant actually wrote.
const QUOTE_MARKERS: readonly RegExp[] = [
  // Gmail, Apple Mail, most clients: "On <date>, <someone> wrote:"
  /^\s*On .+ wrote:\s*$/,
  // Outlook and several others put a divider line with headers beneath.
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*From:\s*.+$/,
  // The convention a machine-generated mail can rely on, and the one this
  // product puts in its own outbound email.
  /^\s*--\s*$/,
  /^\s*>{1,}/,
]

/**
 * The part of an inbound email the person actually typed.
 *
 * CUTS AT THE FIRST MARKER AND KEEPS EVERYTHING ABOVE IT. Top-posting is what
 * essentially every mail client does and what essentially every person does;
 * bottom-posted replies exist and this loses them, which is the trade named
 * rather than hidden. The alternative - trying to interleave - guesses at
 * which quoted lines were edited, and a transcript that guessed is worse than
 * one that is visibly partial.
 *
 * NEVER RETURNS EMPTY when there was any text at all: a reply that is nothing
 * but a quote (somebody hit send by accident, or typed only in the quoted
 * part) still has to be recorded, because `Message` is the evidence trail and
 * "they replied and it was blank" is itself a fact. The raw body comes back
 * instead, and it is the caller's problem that it is long.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let cut = lines.length

  for (const [index, line] of lines.entries()) {
    if (QUOTE_MARKERS.some((marker) => marker.test(line))) {
      cut = index
      break
    }
  }

  const kept = lines.slice(0, cut).join('\n').trim()
  return kept.length > 0 ? kept : body.trim()
}
