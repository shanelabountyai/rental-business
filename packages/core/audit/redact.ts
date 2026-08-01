// Redaction for audit payloads.
//
// This is the single most dangerous part of an audit log, and the danger is
// not obvious: the natural implementation is `before: oldRow, after: newRow`,
// and the moment someone audits a StaffCredential update that snapshot copies
// a password hash and a decryptable MFA secret into a JSON column - in a table
// that is append-only by trigger, so it cannot be cleaned up afterwards.
//
// So redaction is not a courtesy applied at the call site. It runs inside
// recordAudit() on every payload, unconditionally, and the call site cannot
// opt out.

/// Exact field names that must never appear in an audit payload. Matched
/// case-insensitively against the key, not the value.
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set(
  [
    'password',
    'passwordHash',
    'mfaSecret',
    'mfaRecoveryCodes',
    'token',
    'tokenHash',
    'secret',
    'apiKey',
    'accessCode',
    'lockboxCode',
    'ssn',
    'taxId',
    'ein',
    'accountNumber',
    'routingNumber',
    'cardNumber',
  ].map((field) => field.toLowerCase()),
)

/**
 * Names that are sensitive by shape rather than by exact match, so a field
 * added later - `webhookSecret`, `smartLockCode`, `resetToken` - is redacted
 * without anyone remembering to update the list above.
 *
 * These are deliberately broad, because the safe default for a new field is
 * redacted: a secret that leaks into an append-only table cannot be taken
 * back, while an over-redacted field costs someone a moment of annoyance and
 * one line in ALWAYS_SAFE below.
 *
 * Anything ending in `code` is caught, because access codes, lockbox codes and
 * whatever R-014 adds next are all secrets, and PROP-03 treats revealing one
 * as a privileged act.
 *
 * Deliberately NOT matching bare "hash": `Document.sha256` is a content hash
 * proving a file was not swapped. It is evidence, not a secret, and redacting
 * it would damage the trail this item exists to build.
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /password/i,
  /secret/i,
  /token/i,
  /credential/i,
  /apikey|api_key/i,
  /codes?$/i,
  /ssn|socialsecurity/i,
]

/**
 * Fields the patterns above would catch but which carry no secret. Checked
 * FIRST, so this is the only way to opt out - which keeps the default
 * fail-safe and makes every exemption a deliberate, reviewable line.
 */
export const ALWAYS_SAFE: ReadonlySet<string> = new Set(
  [
    'postalCode',
    'countryCode',
    'stateCode',
    'currencyCode',
    'reasonCode',
    'failureCode',
    'errorCode',
    'statusCode',
  ].map((field) => field.toLowerCase()),
)

export const REDACTED = '[redacted]' as const

export function isSensitiveField(name: string): boolean {
  if (ALWAYS_SAFE.has(name.toLowerCase())) return false
  if (SENSITIVE_FIELDS.has(name.toLowerCase())) return true
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Replaces sensitive values with a marker, recursively.
 *
 * Marker rather than deletion on purpose: "this field changed, and we are not
 * telling you to what" is a true and useful audit statement, while a missing
 * key is indistinguishable from a field that was never touched. In a dispute
 * the difference matters.
 *
 * Depth-bounded because an audit payload is a row snapshot, not a graph, and
 * an unbounded walk over a cyclic object would hang the request that was
 * trying to record it.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1))
  }

  if (value instanceof Date) return value.toISOString()

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveField(key) ? REDACTED : redact(item, depth + 1)
    }
    return output
  }

  // Primitives pass through. Redaction is by field name, never by sniffing
  // values - a value-based heuristic would eventually redact a rent amount
  // that happened to look like a card number.
  return value
}

export type Snapshot = Record<string, unknown> | null | undefined

export interface Change {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

/**
 * Narrows a before/after pair to the fields that actually changed, then
 * redacts both sides.
 *
 * Storing whole rows would duplicate the record into the audit table and make
 * "what changed?" a diffing exercise for whoever reads it later - in a
 * courtroom, most likely. Storing only the delta keeps the log answering the
 * question it is asked.
 *
 * `updatedAt` is dropped: it changes on every write by definition and its
 * presence in every entry is noise that hides the field that mattered.
 */
export function changedFields(before: Snapshot, after: Snapshot): Change {
  if (!before && !after) return { before: null, after: null }

  // A create has no before; a delete has no after. Both are recorded whole.
  if (!before) return { before: null, after: redact(after) as Record<string, unknown> }
  if (!after) return { before: redact(before) as Record<string, unknown>, after: null }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  keys.delete('updatedAt')

  const beforeDelta: Record<string, unknown> = {}
  const afterDelta: Record<string, unknown> = {}

  for (const key of keys) {
    if (!sameValue(before[key], after[key])) {
      beforeDelta[key] = isSensitiveField(key) ? REDACTED : redact(before[key])
      afterDelta[key] = isSensitiveField(key) ? REDACTED : redact(after[key])
    }
  }

  if (Object.keys(afterDelta).length === 0) {
    return { before: null, after: null }
  }
  return { before: beforeDelta, after: afterDelta }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a === null || b === null || a === undefined || b === undefined) {
    return false
  }
  if (typeof a === 'object' && typeof b === 'object') {
    // Row snapshots are shallow JSON; a structural compare is enough and
    // avoids pulling in a deep-equal dependency for arrays of scalars.
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}
