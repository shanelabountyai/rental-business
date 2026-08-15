// Managed templates and their merge fields (COMM-03, R-049).
//
// ==========================================================================
// THIS GIVES UP COMPILE-TIME SAFETY, AND THE WHOLE DESIGN IS ABOUT BUYING IT
// BACK.
//
// `packages/core/notifications/templates.ts` says, in its own header, why the
// automated templates are typed FUNCTIONS rather than strings with
// `{{placeholders}}`: "a template referencing a field the caller does not
// pass is a build error rather than a rent reminder that says 'Hi undefined'".
// That reasoning is correct and unchanged.
//
// A managed template is a string a property manager typed into a textarea, so
// no compiler will ever see it. Every guarantee the typed version got for
// free has to be re-earned at runtime:
//
//   - a CLOSED CATALOGUE of merge fields, so `{{tenant.frist_name}}` is
//     rejected when it is saved rather than mailed to somebody
//   - VALIDATION ON SAVE, which is the last moment a human is present
//   - RENDER REPORTS WHAT IT COULD NOT FILL, never substituting a blank, so
//     the send path can refuse instead of posting "Hi ," to a tenant
//   - PREVIEW against real data before anything goes out (COMM-03's own
//     acceptance criterion)
//
// D-10 still governs the WORDS: home or unit, maintenance request, no
// internal identifier. A managed template can violate that in ways review has
// to catch — which is a reason the catalogue exposes no id fields at all.
// ==========================================================================

/// What a template is FOR, which decides how strictly it is handled.
///
/// `LEGAL` is not a label. A legal notice may only be sent in a language
/// somebody approved, may never be machine-translated, and carries the
/// draft-not-legal-advice line. `ROUTINE` is a rent reminder or a welcome
/// packet, where a machine translation is better than nothing.
export const TEMPLATE_KINDS = ['ROUTINE', 'LEGAL'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

export interface MergeField {
  /// The token as typed, without braces: `tenant.first_name`.
  key: string
  /// Shown beside the field in the editor. A PM picking from a list needs to
  /// know what lands there, not what column it came from.
  label: string
  example: string
}

/**
 * Every field a managed template may reference.
 *
 * ==========================================================================
 * CLOSED, AND DELIBERATELY SMALL. Two rules decide what is on it:
 *
 *   NO INTERNAL IDENTIFIERS. No lease id, no ticket number, no status enum —
 *   D-10 forbids them in tenant-facing text, and a catalogue that offers one
 *   is an invitation. This is why there is no `lease.id`, and it is not an
 *   oversight.
 *
 *   NOTHING THAT NEEDS A DECISION. `balance.total` is here; `balance.late_fee`
 *   is not, because what a late fee should be is a jurisdiction question
 *   (D-4/D-12) that core answers per-lease per-day, and a template quoting one
 *   would be quoting a number nobody computed for this tenancy. A template
 *   states facts; it does not do arithmetic.
 * ==========================================================================
 */
export const MERGE_FIELDS: readonly MergeField[] = [
  { key: 'tenant.first_name', label: "Tenant's first name", example: 'Dana' },
  { key: 'tenant.last_name', label: "Tenant's last name", example: 'Reyes' },
  { key: 'tenant.full_name', label: "Tenant's full name", example: 'Dana Reyes' },
  { key: 'property.name', label: 'Property name', example: 'Cedar Row' },
  { key: 'property.address', label: 'Street address', example: '18 Cedar Row' },
  { key: 'unit.name', label: 'Unit', example: 'A' },
  { key: 'lease.rent', label: 'Monthly rent', example: '$1,500.00' },
  { key: 'lease.starts_on', label: 'Lease start date', example: '2026-01-01' },
  { key: 'lease.ends_on', label: 'Lease end date', example: '2026-12-31' },
  { key: 'balance.total', label: 'What the tenant owes today', example: '$1,500.00' },
  { key: 'balance.due_on', label: 'Date the balance is due', example: '2026-09-01' },
  { key: 'today', label: "Today's date, in the property's timezone", example: '2026-08-15' },
  { key: 'company.name', label: 'Your business name', example: 'Cedar Row Rentals' },
  { key: 'company.phone', label: 'Your contact number', example: '(512) 555-0134' },
] as const

const FIELD_KEYS: ReadonlySet<string> = new Set(MERGE_FIELDS.map((field) => field.key))

/// `{{ tenant.first_name }}` — braces, any inner whitespace, dots and
/// underscores. Deliberately NOT a general expression syntax: the moment a
/// template can contain logic it is a program a PM is writing unreviewed, and
/// the failure mode stops being a wrong word and starts being a wrong number.
const TOKEN = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi

/// Every field a body references, in order of first appearance, deduplicated.
export function mergeFieldsUsed(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(TOKEN)) {
    seen.add(match[1].toLowerCase())
  }
  return [...seen]
}

/// Referenced fields that are not on the catalogue. What validation refuses
/// and what a typo becomes: `{{tenant.frist_name}}` → `['tenant.frist_name']`.
export function unknownMergeFields(text: string): string[] {
  return mergeFieldsUsed(text).filter((key) => !FIELD_KEYS.has(key))
}

export interface TemplateInput {
  name: string
  kind: TemplateKind
  /// Optional. SMS has no subject line; an email without one is a template
  /// that will be delivered looking like spam.
  subject: string | null
  body: string
}

export interface Violation {
  field: string
  message: string
}

/**
 * Whether a template may be saved.
 *
 * ON SAVE, because that is the last moment a human is in the room. Every
 * other checkpoint — preview, send — is either optional or automated, and a
 * template with a typo in a merge field that reaches the send path is a
 * message that goes out wrong to everybody it is sent to at once.
 */
export function validateTemplate(input: TemplateInput): Violation[] {
  const violations: Violation[] = []

  if (!input.name.trim()) {
    violations.push({ field: 'name', message: 'Give the template a name you will recognise.' })
  }
  if (!input.body.trim()) {
    violations.push({ field: 'body', message: 'A template needs a body.' })
  }

  const unknown = [...unknownMergeFields(input.body), ...unknownMergeFields(input.subject ?? '')]
  if (unknown.length > 0) {
    // NAMES THE FIELD. "Invalid merge field" sends somebody hunting through
    // their own paragraph; naming it is the difference between a five-second
    // fix and an abandoned template.
    violations.push({
      field: unknownMergeFields(input.body).length > 0 ? 'body' : 'subject',
      message: `Not a merge field: ${[...new Set(unknown)].map((key) => `{{${key}}}`).join(', ')}. Pick from the list.`,
    })
  }

  // A one-line legal notice is almost certainly a routine message somebody
  // mislabelled, and the consequence of the mislabel runs the wrong way: it
  // locks the template to approved translations it will never have.
  if (input.kind === 'LEGAL' && input.body.trim().length < 40) {
    violations.push({
      field: 'body',
      message: 'A legal notice needs to say what it is about, what is required, and by when.',
    })
  }

  return violations
}

export interface RenderResult {
  text: string
  /// Fields the template asked for that had no value for THIS recipient.
  ///
  /// Returned rather than blanked. A missing value is a real condition — a
  /// tenant with no lease end date on a month-to-month, a balance nobody has
  /// computed — and silently substituting an empty string produces "Your
  /// lease ends on ." which reads as a broken system and destroys the trust
  /// the message was sent to build.
  missing: string[]
}

/**
 * Fills a template for one recipient.
 *
 * NEVER PRINTS `undefined` AND NEVER PRINTS A BLANK. An unresolved field is
 * left standing as its own token so it is visible in preview, and named in
 * `missing` so the send path can refuse. Those are the two failure modes the
 * typed templates got for free.
 */
export function renderTemplate(
  text: string,
  values: Readonly<Record<string, string | null | undefined>>,
): RenderResult {
  const missing: string[] = []

  const rendered = text.replace(TOKEN, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase()
    const value = values[key]
    if (value == null || value === '') {
      if (!missing.includes(key)) missing.push(key)
      // The token itself, not a blank. Visible in preview, and impossible to
      // mistake for prose that was meant to be there.
      return whole
    }
    return value
  })

  return { text: rendered, missing }
}

export interface Translation {
  locale: string
  subject: string | null
  body: string
  /// Null until somebody with authority signed it off. The whole point of
  /// the field: COMM-03 permits machine translation for routine chat and
  /// forbids it for legal notices, and "was this approved" is the only thing
  /// that distinguishes them once both are rows in a table.
  approvedAt: Date | null
}

export type LanguageOutcome =
  /// An approved translation in the tenant's own language.
  | { use: 'translation'; locale: string; approved: true }
  /// A translation exists but nobody approved it. Fine for routine, refused
  /// for legal.
  | { use: 'translation'; locale: string; approved: false }
  /// No translation at all. Falls back to the default language.
  | { use: 'default'; reason: 'no_translation' }
  /// A LEGAL notice with no APPROVED translation in the tenant's language.
  /// Falls back to the default language and says so, loudly.
  | { use: 'default'; reason: 'unapproved_translation_for_legal' }

/**
 * Which language version to send, given the tenant's preference.
 *
 * ==========================================================================
 * THE ONE RULE THIS ITEM CANNOT GET WRONG (COMM-03).
 *
 * "The stored attorney-approved translation is used for legal notices;
 * machine translation permitted only for routine chat."
 *
 * So an unapproved translation is USABLE for a rent reminder and REFUSED for
 * a notice to vacate. The refusal falls back to the default language rather
 * than blocking the send, and reports why — because the alternative outcomes
 * are both worse than a notice in the wrong language:
 *
 *   Sending the unapproved translation means serving a legal notice whose
 *   words nobody with authority has read. A mistranslated cure period is not
 *   a typo; it is a defective notice, and the tenant relied on it.
 *
 *   Refusing to send at all means a tenant who chose Spanish silently
 *   receives nothing, which is worse than receiving English.
 *
 * The caller is expected to surface `unapproved_translation_for_legal` to
 * staff, not swallow it — it is the signal that a translation needs review,
 * and it is the only way anybody learns the gap exists.
 * ==========================================================================
 */
export function languageFor(
  kind: TemplateKind,
  preferredLocale: string | null,
  translations: readonly Translation[],
  defaultLocale = 'en',
): LanguageOutcome {
  if (!preferredLocale || preferredLocale === defaultLocale) {
    return { use: 'default', reason: 'no_translation' }
  }

  const match = translations.find((t) => t.locale === preferredLocale)
  if (!match) return { use: 'default', reason: 'no_translation' }

  if (match.approvedAt != null) {
    return { use: 'translation', locale: match.locale, approved: true }
  }

  return kind === 'LEGAL'
    ? { use: 'default', reason: 'unapproved_translation_for_legal' }
    : { use: 'translation', locale: match.locale, approved: false }
}
