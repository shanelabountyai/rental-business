// Which service methods a jurisdiction allows, per notice type (R-051,
// COMM-02, D-4).
//
// ==========================================================================
// THE DISTINCTION THIS FILE EXISTS TO HOLD: A MECHANIC IS NOT A PERMISSION.
//
// `NoticeServiceMethod` has listed PERSONAL / POSTED_WITH_PHOTO /
// CERTIFIED_MAIL / ... since R-002, and that list has only ever meant "these
// are the ways this product can record proof". It has never said any of them
// is lawful where the property is. Whether posting on the door serves a
// notice to vacate in Texas is a statutory question, so under D-4 it is
// versioned, effective-dated configuration and not a constant in code.
//
// Three answers, not two. `true` and `false` both require a configured rule;
// everything else is `null`, meaning NOBODY HAS TOLD US. That is deliberately
// not `false` - the same call R-044 makes with `graceUnknown` and
// `assessLateFees` makes with a missing rule. "We do not know what this state
// allows" and "this state forbids it" are different facts, and only one of
// them is an accusation against the person serving the notice.
//
// A null answer never blocks service. An owner in an unconfigured state still
// has to serve notices, and refusing to record what they actually did would
// produce no evidence at all - which is worse than evidence carrying an
// honest "unverified" flag.
// ==========================================================================

/// The mechanics this product can record proof for. Mirrors the
/// `NoticeServiceMethod` enum; kept here so core does not import from the
/// database package for a closed list of strings.
export const NOTICE_SERVICE_METHODS = [
  'PERSONAL',
  'POSTED_WITH_PHOTO',
  'CERTIFIED_MAIL',
  'FIRST_CLASS_MAIL',
  'EMAIL',
  'PORTAL',
  'PROCESS_SERVER',
] as const

export type NoticeServiceMethodName = (typeof NOTICE_SERVICE_METHODS)[number]

export const SERVICE_METHOD_LABELS: Record<NoticeServiceMethodName, string> = {
  PERSONAL: 'Handed to the tenant',
  POSTED_WITH_PHOTO: 'Posted on the door (photo)',
  CERTIFIED_MAIL: 'Certified mail',
  FIRST_CLASS_MAIL: 'First-class mail',
  EMAIL: 'Email',
  PORTAL: 'Tenant portal',
  PROCESS_SERVER: 'Process server',
}

/// Which methods carry proof this product can actually verify, as opposed to
/// ones where the record rests on a staff member's word. Not a judgement
/// about lawfulness - `PERSONAL` service is lawful nearly everywhere and has
/// no artifact behind it. It drives what the serve form asks for.
export const METHODS_REQUIRING_PROOF: readonly NoticeServiceMethodName[] = [
  'POSTED_WITH_PHOTO',
  'CERTIFIED_MAIL',
]

/// Notice types the product itself generates or expects. Notice types are
/// free-form configuration (see `Notice.type`) precisely so a state that
/// invents one needs no migration - this list is what the admin form offers,
/// never a closed set the database enforces.
export const KNOWN_NOTICE_TYPES = [
  'ENTRY_NOTICE',
  'PAY_OR_QUIT',
  'NOTICE_TO_VACATE',
  'LEASE_VIOLATION',
  'RENT_INCREASE',
  'REPAIR_CHARGE',
] as const

export const NOTICE_TYPE_LABELS: Record<string, string> = {
  ENTRY_NOTICE: 'Notice of entry',
  PAY_OR_QUIT: 'Pay or quit',
  NOTICE_TO_VACATE: 'Notice to vacate',
  LEASE_VIOLATION: 'Lease violation',
  RENT_INCREASE: 'Rent increase',
  REPAIR_CHARGE: 'Repair charge',
}

export function noticeTypeLabel(type: string): string {
  return NOTICE_TYPE_LABELS[type] ?? type
}

/// `{ "NOTICE_TO_VACATE": ["PERSONAL", "CERTIFIED_MAIL"] }`
export type ServiceMethodMap = Record<string, NoticeServiceMethodName[]>

function isMethod(value: unknown): value is NoticeServiceMethodName {
  return (
    typeof value === 'string' &&
    (NOTICE_SERVICE_METHODS as readonly string[]).includes(value)
  )
}

/**
 * Reads the `JurisdictionRule.noticeServiceMethods` JSON column.
 *
 * TOTAL AND FORGIVING, because the column is `Json` and Postgres will hold
 * whatever was put there - including something written by an older version of
 * this code, or by hand. A shape this cannot understand yields `null`
 * ("nobody has told us") rather than throwing, because the alternative is a
 * notice screen that 500s for one badly-configured state and takes the other
 * forty-nine with it. Unknown method names inside a good-shaped map are
 * dropped individually for the same reason.
 */
export function parseServiceMethodMap(value: unknown): ServiceMethodMap | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null

  const parsed: ServiceMethodMap = {}
  for (const [noticeType, methods] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(methods)) continue
    const kept = methods.filter(isMethod)
    // An explicitly EMPTY list is meaningful and preserved: it says this
    // state permits none of the methods we can record, which is a real
    // (if unusual) answer and must not read back as "unconfigured".
    parsed[noticeType] = kept
  }
  return Object.keys(parsed).length > 0 ? parsed : null
}

export interface ServiceMethodRule {
  noticeServiceMethods?: unknown
}

/**
 * The methods this jurisdiction permits for `noticeType`, or null when
 * nothing is configured for it.
 */
export function serviceMethodsFor(
  rule: ServiceMethodRule | null | undefined,
  noticeType: string,
): NoticeServiceMethodName[] | null {
  const map = parseServiceMethodMap(rule?.noticeServiceMethods)
  if (!map) return null
  const methods = map[noticeType]
  return methods ?? null
}

/**
 * Whether `method` serves `noticeType` here.
 *
 * `null` means unconfigured - see this file's header for why that is not
 * `false`, and why it must never block recording the service.
 */
export function servicePermitted(
  rule: ServiceMethodRule | null | undefined,
  noticeType: string,
  method: NoticeServiceMethodName,
): boolean | null {
  const methods = serviceMethodsFor(rule, noticeType)
  if (!methods) return null
  return methods.includes(method)
}

/**
 * What a screen says about a recorded service event, given what was known
 * when it happened. Reads from the stored `permittedByJurisdiction` rather
 * than recomputing, because a rule edited after service must not silently
 * rewrite the history of a notice already served (D-4: rules apply
 * prospectively, and changing one never rewrites what it produced).
 */
export function serviceStandingLabel(permitted: boolean | null): string {
  if (permitted === true) return 'Method permitted in this jurisdiction'
  if (permitted === false) return 'Method NOT permitted in this jurisdiction'
  return 'No service rules configured for this state — unverified'
}
