/**
 * Carrier opt-out keywords, and the exact rule for matching them (R-040e).
 *
 * WHY THIS IS A CLOSED, WHOLE-MESSAGE MATCH AND NOT A SEARCH.
 *
 * A tenant who texts `STOP` has told the carrier to block our number. A
 * tenant who texts *"please stop the leak under the sink"* has reported a
 * maintenance emergency. Those two messages share a word and nothing else,
 * and the cost of confusing them is not symmetric:
 *
 *   Treating a real STOP as ordinary text opens a maintenance ticket titled
 *   `STOP`, which is embarrassing.
 *
 *   Treating ordinary text as a STOP silently unsubscribes somebody from
 *   `entry_notice` - the one category `LOCKED_CATEGORIES` says a tenant may
 *   NOT turn off, because it is the legally significant message telling them
 *   somebody is coming into their home. They would then stop receiving entry
 *   notices, having never asked to, and our own record would go on looking
 *   normal.
 *
 * So a KEYWORD matches the whole message or nothing, which is also what the
 * carriers themselves do: no fuzzy matching, stemming, or "contains".
 *
 * The one exception is a closed list of revocation SENTENCES (LEGAL-04,
 * D-279). The FCC's 2025 rule requires honouring a revocation made in any
 * reasonable words, so "please stop texting me" must opt out. Each phrase
 * names texting or contacting, which a repair message never does. The
 * carrier does not block on a sentence, so for these our own `SmsOptOut`
 * record is the only thing that stops the sending.
 *
 * The keyword lists are the CTIA/industry standard set. They are here rather
 * than in the Twilio adapter because they are a fact about US SMS, not about
 * one provider - and because the simulator has to answer the same way the
 * carrier would (D-27: a simulated adapter must not agree with us by
 * construction).
 */

export type OptOutKeyword = 'STOP' | 'START' | 'HELP'

/// Stops all messages. `STOP` is the one every carrier honours; the rest are
/// the industry-standard synonyms, plus the FCC's own list of words that are
/// a revocation per se (47 CFR 64.1200(a)(10), 2025): stop, quit, end,
/// revoke, opt out, cancel, unsubscribe (LEGAL-04).
const STOP_WORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
  'OPTOUT',
  'OPT OUT',
  'OPT-OUT',
])

/// Resumes messages after a STOP. NOT `YES` (LEGAL-04, D-279): somebody who
/// opted out and later answers "Yes" to a question in the thread has not
/// asked to be texted again, and a resubscribe has to be a word nobody sends
/// by accident.
const START_WORDS = new Set(['START', 'UNSTOP'])

/// Sentences that revoke consent to texts. The FCC rule says a revocation in
/// ANY reasonable words must be honoured, so "please stop texting me" cannot
/// be filed as a maintenance message. Every phrase names texting, messaging or
/// contacting us, which is what keeps "please stop the leak" out: none of
/// these can occur in a message about a repair. Substring match on the
/// lowercased, whitespace-collapsed body, the same shape as
/// `isEmailOptOutRequest`'s list.
const STOP_PHRASES: readonly string[] = [
  'stop texting',
  'stop sending me text',
  'stop sending texts',
  'stop messaging me',
  'stop sending me messages',
  'stop contacting me',
  "don't text me",
  'dont text me',
  'do not text me',
  "don't message me",
  'do not message me',
  "don't contact me",
  'do not contact me',
  'no more texts',
  'no more text messages',
  'opt me out',
  'remove me from your',
  'take me off your',
  'remove my number',
  'revoke my consent',
  'revoke consent',
]

/// Asks who we are. The carrier answers this one itself; we recognise it so
/// it does not become a maintenance ticket.
const HELP_WORDS = new Set(['HELP', 'INFO'])

/**
 * Classify an inbound SMS body.
 *
 * Returns null for anything that is not exactly one keyword or a sentence
 * from `STOP_PHRASES` - which is almost every real message, and deliberately
 * includes `"STOP the leak"` and any other sentence that merely contains a
 * keyword.
 *
 * Case and surrounding whitespace are ignored, because handsets capitalise
 * unpredictably and a trailing newline is not a different intention. A single
 * trailing `.` or `!` is tolerated for the same reason: `"Stop."` is somebody
 * opting out, and treating it as a maintenance request would be the
 * expensive mistake above.
 */
export function classifyOptOutKeyword(body: string): OptOutKeyword | null {
  const word = body.trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ').toUpperCase()
  if (word.length === 0) return null

  if (STOP_WORDS.has(word)) return 'STOP'
  if (START_WORDS.has(word)) return 'START'
  if (HELP_WORDS.has(word)) return 'HELP'

  // A sentence is a message rather than a command, unless it is one of the
  // revocation sentences. Only STOP has a sentence form: a resubscribe or a
  // HELP stays a keyword.
  const text = word.toLowerCase().replace(/\u2019/g, "'")
  if (STOP_PHRASES.some((phrase) => text.includes(phrase))) return 'STOP'
  return null
}

/**
 * The reply the carrier expects for HELP, and the confirmation for START.
 *
 * STOP gets no reply from us: the carrier sends its own confirmation and
 * then blocks the number, so anything we queued would be undeliverable and
 * would sit in the outbox failing. That asymmetry is the whole reason this
 * returns null for STOP rather than a polite acknowledgement.
 */
export function optOutReply(
  keyword: OptOutKeyword,
  businessName: string,
): string | null {
  if (keyword === 'STOP') return null
  if (keyword === 'START') {
    return `${businessName}: you are subscribed again and will receive messages about your home. Reply STOP to opt out.`
  }
  return `${businessName}: messages about your home - rent, maintenance and entry notices. Reply STOP to opt out. Message and data rates may apply.`
}
