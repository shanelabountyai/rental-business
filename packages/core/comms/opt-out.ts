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
 * So the match is the whole message or nothing, which is also what the
 * carriers themselves do. The CTIA keyword set is fixed and small; this is
 * not a place for fuzzy matching, stemming, or "contains".
 *
 * The keyword lists are the CTIA/industry standard set. They are here rather
 * than in the Twilio adapter because they are a fact about US SMS, not about
 * one provider - and because the simulator has to answer the same way the
 * carrier would (D-27: a simulated adapter must not agree with us by
 * construction).
 */

export type OptOutKeyword = 'STOP' | 'START' | 'HELP'

/// Stops all messages. `STOP` is the one every carrier honours; the rest are
/// the industry-standard synonyms handsets and carriers also accept.
const STOP_WORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
])

/// Resumes messages after a STOP.
const START_WORDS = new Set(['START', 'UNSTOP', 'YES'])

/// Asks who we are. The carrier answers this one itself; we recognise it so
/// it does not become a maintenance ticket.
const HELP_WORDS = new Set(['HELP', 'INFO'])

/**
 * Classify an inbound SMS body.
 *
 * Returns null for anything that is not exactly one keyword - which is almost
 * every real message, and deliberately includes `"STOP the leak"`,
 * `"stop!"` with punctuation attached to other words, and any multi-word
 * message containing a keyword.
 *
 * Case and surrounding whitespace are ignored, because handsets capitalise
 * unpredictably and a trailing newline is not a different intention. A single
 * trailing `.` or `!` is tolerated for the same reason: `"Stop."` is somebody
 * opting out, and treating it as a maintenance request would be the
 * expensive mistake above.
 */
export function classifyOptOutKeyword(body: string): OptOutKeyword | null {
  const word = body.trim().replace(/[.!]+$/, '').toUpperCase()
  if (word.length === 0) return null
  // One token only. Anything with whitespace inside it is a sentence, and a
  // sentence is a message rather than a command.
  if (/\s/.test(word)) return null

  if (STOP_WORDS.has(word)) return 'STOP'
  if (START_WORDS.has(word)) return 'START'
  if (HELP_WORDS.has(word)) return 'HELP'
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
