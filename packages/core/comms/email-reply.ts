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
 * The bare address out of one mail header value.
 *
 * ==========================================================================
 * EVERY REAL MAIL CLIENT SENDS `Display Name <addr@example.com>`, and this
 * used to be applied to the RECIPIENT list only - where the reply key is -
 * and never to `From:`, where the ROUTING is.
 *
 * So `candidatesForEmail` compared the whole header value against
 * `Tenant.email` and matched nothing, and every inbound email from a client
 * that sets a display name went to the unrouted queue. That is R-097a,
 * R-097d, R-097e and R-097f all silently doing nothing for a real tenant: no
 * ticket, the photograph counted rather than kept, the opt-out not honoured.
 * And it is INVISIBLE, because an unrouted message is what the queue is for -
 * it looks exactly like mail from a stranger we cannot place. Found by Golden
 * Path 4, which is the first thing to send a From: header shaped the way a
 * mail client shapes one (D-132).
 *
 * A `From:` header is ONE mailbox, so it is never split on commas: doing that
 * is what broke `"Vaughan, Dorothy" <d@example.com>` a second way, leaving
 * `"Vaughan` as the sender.
 * ==========================================================================
 *
 * Lower-cased, matching `candidatesForEmail`, which lower-cases before it
 * compares. Returns the input trimmed when there are no angle brackets - a
 * bare address is the other half of what providers send.
 */
export function emailAddressOnly(raw: string): string {
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase()
}

/**
 * One recipient header split into its individual mailboxes.
 *
 * ==========================================================================
 * A COMMA INSIDE A QUOTED DISPLAY NAME IS NOT A SEPARATOR, and splitting on
 * every comma is what D-132 left behind when it fixed `From:`. `To:` and
 * `Cc:` genuinely ARE lists, so they do have to be split - but
 * `"Vaughan, Dorothy" <d@example.com>, hello+k7x2…@inbound.example.com`
 * split naively yields `"Vaughan`, `Dorothy" <d@example.com>` and the key,
 * and the two broken halves are indistinguishable from real recipients.
 *
 * The cost is not the mangled name, which nothing reads. It is that a
 * recipient list is where the REPLY KEY lives, and the key is the only
 * high-confidence match inbound email has: lose it and a tenant with
 * tenancies at two properties becomes `decideRoute`'s AMBIGUOUS case and
 * lands in the unrouted queue. Sorting-office mail, autoresponders and
 * anybody with a comma in their name all put one in that list routinely.
 *
 * THIS IS NOT AN RFC 5322 PARSER, and saying so is the point. It does not
 * handle groups (`Managers: a@b, c@d;`), comments, folded headers or encoded
 * words. What it handles is a comma that is inside a quoted string or inside
 * angle brackets, which is the whole of what breaks on the mail people
 * actually send. A real parser is a dependency or a large file, and neither
 * is worth it for a header whose only job here is to be scanned for one tag.
 * ==========================================================================
 */
export function splitAddressList(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angled = false

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (quoted) {
      // RFC 5322 quoted-pair: a backslash escapes whatever follows, so the
      // closing quote of `"O\"Hara, P"` is the last one and not the middle
      // one. Both characters are kept - this splits, it never rewrites.
      if (char === '\\' && index + 1 < raw.length) {
        current += char + raw[index + 1]!
        index += 1
        continue
      }
      if (char === '"') quoted = false
      current += char
      continue
    }
    if (char === '"') {
      quoted = true
      current += char
      continue
    }
    // An addr-spec cannot contain a bare comma, so this guards a malformed
    // `<a,b@c>` rather than a legal address - cheap, and it means a mangled
    // header costs one unusable recipient instead of two.
    if (char === '<') angled = true
    else if (char === '>') angled = false
    else if (char === ',' && !angled) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)

  return parts.map((part) => part.trim()).filter(Boolean)
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

  // Split again here rather than trusting the caller to have done it. This
  // is the shared function every recipient list reaches, and D-132's lesson
  // was precisely that a helper living beside one caller is a helper the
  // next caller does not know exists - so a caller that passes a whole
  // unsplit `To:` header works too. Idempotent on an already-split list: a
  // single mailbox splits to itself.
  for (const raw of input.recipients.flatMap(splitAddressList)) {
    // `Name <addr@example.com>` as well as a bare address.
    const address = emailAddressOnly(raw)
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

// ---------------------------------------------------------------------------
// HTML-only email (R-097d)
// ---------------------------------------------------------------------------

/// The entities that actually turn up in mail. Deliberately not a full table:
/// a handful covers real messages, and anything unrecognised is left as
/// written rather than guessed at - a visible `&hellip;` is a cosmetic
/// blemish, a wrong guess is a changed sentence in an evidence trail.
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * The readable text of an HTML-only email.
 *
 * THIS EXISTS BECAUSE THE ALTERNATIVE WAS STORING NOTHING. R-097a took the
 * plain-text part and fell back to an empty string, so a client that sent
 * only HTML - which several mobile clients do by default - filed a blank
 * message. A tenant who typed a paragraph got a record saying they said
 * nothing, which is worse than a record that is slightly ugly.
 *
 * NO DEPENDENCY, AND NO PARSER. A converter that is correct on hostile HTML
 * is a large thing; this one is correct on the mail people actually send and
 * is trivially safe on anything else, because it only ever DELETES. Nothing
 * here interprets, executes, fetches or renders - script and style contents
 * are dropped whole, every remaining tag is removed, and what is left is
 * text. The output goes into an append-only message body and is rendered as
 * text by React, so the worst a malicious input can produce is nonsense
 * somebody reads.
 */
export function htmlToText(html: string): string {
  return (
    html
      // Whole elements whose CONTENT is not prose. Dropped before tags are
      // stripped, or a stylesheet becomes body text.
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      // Block boundaries become line breaks before the tags go, so a
      // paragraph structure survives as blank lines rather than collapsing
      // into one run-on sentence.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
      // Mail HTML is full of indentation that means nothing once the tags
      // are gone.
      .split('\n')
      .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

// ---------------------------------------------------------------------------
// "Stop emailing me" (R-097e)
// ---------------------------------------------------------------------------
//
// ==========================================================================
// AN EMAIL OPT-OUT IS NOT AN SMS `STOP`, AND TREATING IT AS ONE WOULD BE
// WRONG IN BOTH DIRECTIONS.
//
// `STOP` is a single token with legal force that the CARRIER enforces - it
// blocks the number itself, which is why `optOutReply` deliberately sends no
// confirmation. Email has no carrier and no command grammar: people write a
// sentence, and nobody else enforces anything. So detection has to read
// prose, and the product has to do the honouring itself.
//
// WHICH MAKES A FALSE POSITIVE THE EXPENSIVE MISTAKE HERE, exactly inverting
// `classifyOptOutKeyword`'s trade-off. That one is deliberately generous,
// because filing "STOP the leak" as a maintenance request risks continuing to
// text somebody who asked us not to. Here, a tenant whose rent reminders were
// silently switched off because they wrote "stop" in a sentence about a
// dripping tap gets a late fee. So every phrase below is MULTI-WORD and
// unambiguous - none of them can occur in a message about a boiler - and
// "stop" alone is deliberately not one of them.
// ==========================================================================

/// Each of these is a sentence fragment nobody writes by accident while
/// reporting a repair. `unsubscribe` is the single exception to the
/// multi-word rule, because the word has exactly one meaning in an email.
const OPT_OUT_PHRASES: readonly string[] = [
  'unsubscribe',
  'stop emailing',
  'stop sending me email',
  'stop sending emails',
  'remove me from your',
  'take me off your',
  'opt out',
  'opt-out',
  'do not email me',
  "don't email me",
  'no more emails',
]

/**
 * Whether an inbound email is asking us to stop emailing.
 *
 * Reads the body AFTER the quoted tail has been stripped, which matters more
 * than it looks: almost every marketing email ever sent contains the word
 * "unsubscribe" in its footer, so a reply quoting one would otherwise read as
 * an opt-out request every single time.
 */
export function isEmailOptOutRequest(strippedBody: string): boolean {
  const text = strippedBody.toLowerCase()
  return OPT_OUT_PHRASES.some((phrase) => text.includes(phrase))
}

/**
 * The one email that goes out after honouring it.
 *
 * ONE MORE EMAIL AFTER BEING ASKED TO STOP, deliberately, and it is the
 * standard and expected shape: somebody who asks to be unsubscribed expects
 * to be told it happened. What makes it worth the intrusion is the second
 * half - it NAMES WHAT WILL STILL ARRIVE. A tenant who believes they have
 * switched off every email and then misses an entry notice has been misled by
 * us, and the categories that keep coming are exactly the ones they cannot
 * afford to miss.
 *
 * The explanations are `LOCKED_CATEGORIES`' own words, not a second copy:
 * NOTIF-02 requires that reason be shown wherever the question is asked, and
 * this is one of the places it is asked.
 */
export function emailOptOutConfirmation(input: {
  businessName: string
  stoppedCount: number
  stillSending: readonly { label: string; explanation: string }[]
}): { subject: string; body: string } {
  const lines = [
    `We have stopped sending you ${input.stoppedCount === 0 ? 'optional' : 'the optional'} emails about your home.`,
    '',
  ]

  if (input.stillSending.length > 0) {
    lines.push(
      'Some emails will still reach you, because they are the ones you cannot afford to miss:',
      '',
    )
    for (const item of input.stillSending) {
      lines.push(`• ${item.label} — ${item.explanation}`)
    }
    lines.push('')
  }

  lines.push(
    'If you did not mean to do this, or you would like these back on, reply to this message and we will turn them on again.',
  )

  return {
    subject: `${input.businessName}: we have stopped emailing you about your home`,
    body: lines.join('\n'),
  }
}
