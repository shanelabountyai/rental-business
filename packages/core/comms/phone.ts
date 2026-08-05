// Phone normalization for inbound routing (COMM-01, R-017).
//
// THIS IS A SECURITY BOUNDARY, not a formatting nicety. The number on an
// inbound text is the only thing that decides whose permanent conversation
// history it joins. Normalize too loosely and two different people collide;
// normalize inconsistently and a tenant's own replies scatter across threads,
// or land nowhere and get treated as an unknown sender forever.
//
// So the rule is: one canonical form (E.164), stored and compared, with
// anything that cannot be canonicalized confidently rejected outright rather
// than guessed at. A rejected number becomes an UnroutedMessage a human
// looks at - which is a nuisance. A wrongly-matched number is a cross-tenant
// data leak. Those are not the same size of mistake, and this file is biased
// accordingly.
//
// Deliberately NOT a full libphonenumber. This product is US/Canada (NANP)
// today - master PRD's footprint is Texas-first, built per-state - and a
// 200KB metadata dependency to parse numbers we already know are NANP is the
// kind of thing the ladder exists to stop. The moment a genuinely
// international number needs handling, swap this one function for
// libphonenumber-js; every caller already goes through it.

/// E.164: a leading + and up to 15 digits. What we store and compare.
const E164 = /^\+[1-9]\d{1,14}$/

/**
 * Canonical E.164, or null when the input cannot be canonicalized with
 * confidence.
 *
 * Accepts the shapes a NANP number really arrives in - "(512) 555-0142",
 * "512-555-0142", "5125550142", "1-512-555-0142", "+15125550142" - and
 * refuses everything else, including short codes, extensions, and anything
 * with letters in it.
 *
 * Returns null rather than throwing: an unparseable sender is an ordinary
 * runtime condition on an inbound webhook (wrong numbers exist), and the
 * caller records it as unrouted rather than crashing the request and letting
 * the provider retry forever.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // Already canonical - accept as-is rather than round-tripping it, so a
  // genuinely international number stored by some later item is not mangled
  // by the NANP rules below.
  if (E164.test(trimmed)) return trimmed

  // An extension changes who answers, not which line was dialled, but it also
  // means the string is not a bare number. Refuse rather than silently
  // dropping the extension and matching the main line.
  if (/\b(ext|x|extension)\b/i.test(trimmed)) return null
  // Letters anywhere (1-800-FLOWERS, "unknown", "Anonymous") - refuse.
  if (/[a-z]/i.test(trimmed.replace(/^\+/, ''))) return null

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`

  // 3-6 digits is a short code, and anything else is not a number we can
  // place. Both refuse: a short code is never a tenant.
  return null
}

/// For display in a transcript. Never used for comparison - `normalizePhone`
/// output is what gets stored and matched.
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164
}
