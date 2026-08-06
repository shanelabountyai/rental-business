// What a vendor magic link may see and do (D-6, D-16, MAINT-03, R-025).
//
// THIS IS THE ONLY AUTHORIZATION A VENDOR HAS. There is no account, no role,
// no RBAC row - the token IS the credential, and it is scoped to exactly one
// work order. So this file is the vendor equivalent of what
// packages/core/portal/access.ts is for a tenant: an ALLOW-LIST, written as
// a pure function, with the reasoning for each entry stated rather than
// implied.
//
// The rule the whole file exists to enforce: a vendor sees what they need to
// DO THIS ONE JOB and nothing else. Not the tenant's ledger, not the lease,
// not the other tickets at that address, not the property's other work
// orders, not any other unit. Every field below is here because a plumber
// standing at the door cannot do the work without it.

/// Statuses where a dispatched link is still live. A vendor whose work order
/// has been closed, canceled, or handed to somebody else should find a dead
/// link, not a live one they can still upload against - the link outliving
/// its own job is how a fired vendor keeps a gate code.
const ACTIONABLE_STATUSES: ReadonlySet<string> = new Set([
  'ASSIGNED',
  'SCHEDULED',
  'IN_PROGRESS',
  'WORK_COMPLETE',
  'ON_HOLD_WARRANTY',
  'WAITING_ON_TENANT',
])

export interface VendorLinkFacts {
  /// The work order the TOKEN was minted for.
  tokenWorkOrderId: string
  /// The work order actually being requested.
  workOrderId: string
  /// The vendor the TOKEN was minted for, carried in the token's metadata.
  tokenVendorId: string
  /// Who the work order currently names. Reassignment must kill the old
  /// vendor's link even though their token has not expired.
  currentVendorId: string | null
  status: string
}

export type VendorAccessDenial =
  | 'wrong_work_order'
  | 'reassigned'
  | 'not_actionable'

/**
 * Whether this token may act on this work order, right now.
 *
 * Checked on EVERY request, not just the first: a token is a bearer
 * capability that lives for days (D-16), and the world changes underneath
 * it. The three denials are distinct facts a support conversation needs to
 * tell apart, not one generic "no".
 */
export function vendorLinkAccess(
  facts: VendorLinkFacts,
): { ok: true } | { ok: false; reason: VendorAccessDenial } {
  // Belt and braces: the route looks the work order up BY the token's own
  // subjectId, so these should never differ. Checked anyway, because "the
  // id in the URL is the id we authorized" is the assumption every
  // horizontal-privilege bug in this class is built on.
  if (facts.tokenWorkOrderId !== facts.workOrderId) {
    return { ok: false, reason: 'wrong_work_order' }
  }
  // Reassigned to another vendor (or unassigned) since the link went out.
  // The token has not expired and cannot be un-sent, so this comparison is
  // the only thing standing between the old vendor and a live gate code.
  if (facts.currentVendorId !== facts.tokenVendorId) {
    return { ok: false, reason: 'reassigned' }
  }
  if (!ACTIONABLE_STATUSES.has(facts.status)) {
    return { ok: false, reason: 'not_actionable' }
  }
  return { ok: true }
}

/// Whether the vendor may still ANSWER (accept / decline / propose a time).
/// Once they have accepted, the answer stands - changing their mind is a
/// phone call to the PM, not a second click, because staff may already have
/// told the tenant somebody is coming.
export function vendorMayRespond(vendorResponse: string | null): boolean {
  return vendorResponse == null
}

/// Whether the vendor may still upload. Deliberately WIDER than
/// vendorMayRespond: a vendor who declined uploads nothing, but one who
/// accepted keeps uploading right through completion - the invoice usually
/// lands after the work is marked done.
export function vendorMayUpload(vendorResponse: string | null): boolean {
  return vendorResponse === 'ACCEPTED' || vendorResponse === 'PROPOSED_TIME'
}
