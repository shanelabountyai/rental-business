// Habitability keyword detection (MAINT-02, RISK-05), R-019.
//
// `Ticket.habitabilityFlag`'s own schema comment says intake is where it gets
// set: "Set when intake detects habitability language - mold, leak, no heat,
// sewage, infestation." This is that detection. R-023's triage queue reads
// the flag to elevate priority and start a tracked response clock; it does
// not need to re-derive it, because the moment that matters legally is what
// the TENANT actually wrote, not what a later re-scan of edited staff notes
// would find.
//
// A plain keyword scan, not a classifier - these five words/phrases are
// explicitly named in the PRD, and a false positive here costs a habitability
// review that turns out to be routine, while a false negative costs a
// genuine habitability issue quietly sitting in the ordinary queue. That
// asymmetry is exactly why this errs toward over-flagging: substring
// matching on a short, PRD-given list, not language understanding.

const HABITABILITY_KEYWORDS = [
  'mold',
  'mould',
  'leak',
  'no heat',
  'sewage',
  'infestation',
  'infested',
] as const

/// Whether `text` contains habitability language. Case-insensitive substring
/// match against the whole submitted text (category answers, troubleshooting
/// notes, and any free-text fields), so "no heat in the bedroom" and "MOLD on
/// the ceiling" both flag regardless of where in the request they appear.
export function detectHabitabilityLanguage(text: string): boolean {
  const lower = text.toLowerCase()
  return HABITABILITY_KEYWORDS.some((keyword) => lower.includes(keyword))
}
