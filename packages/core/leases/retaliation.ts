// The retaliation-claim guard (RISK-06, R-055; D-4).
//
// Many states presume retaliation when an owner raises rent, non-renews or
// serves notice within a window after a tenant complaint or exercise of
// legal rights. "No mainstream tool does this" is the backlog's own framing,
// and it is cheap here specifically because R-055 does not have to build a
// complaint log - R-023 already stamps `Ticket.habitabilityFlag` at intake,
// so the only new fact this item introduces is the WINDOW LENGTH, which is
// a jurisdiction number like every other one (D-4) and lives on
// JurisdictionRule.
//
// Pure and DB-free, matching packages/core/entry/validate.ts's split: the
// caller (apps/web/lib/leases/retaliation-check.ts) fetches the most recent
// protected act and the configured window; this decides whether that fact
// falls inside it and what to say about it if so.
//
// R-212 widened "protected act" past the habitability ticket R-055 started
// from: a fair-housing accommodation request is protected activity in its
// own right, and an owner who raises rent three weeks after one is answering
// the same question in front of the same judge. It stays a CLOSED list of
// facts this database already records - a code-enforcement complaint or a
// written repair demand that arrived as an ordinary ticket still opens no
// window, because nothing in the product knows it happened.

interface Violation {
  field: string
  message: string
}

/// Which record opened the window. Named, not inferred from the id, because
/// the audit row a retaliation defence is read from has to say WHAT the
/// tenant did, and "a cuid" does not.
export type RetaliationSource = 'habitability_ticket' | 'accommodation_request'

export interface RetaliationComplaint {
  source: RetaliationSource
  /// The Ticket or AccommodationRequest row.
  sourceId: string
  /// What to CALL it in the warning, already a human phrase: "no heat
  /// complaint", "accommodation request". Built by the caller from the
  /// ticket's own free-text category, never an internal code (D-10) - and a
  /// phrase rather than a category because the two sources do not share a
  /// noun, and "this tenant's accommodation request complaint" is not a
  /// sentence anybody would write.
  description: string
  occurredAt: Date
}

export interface RetaliationCheckInput {
  /// When the adverse action is actually taking effect - `new Date()` for a
  /// rent change happening now, or the notice's own `givenOn` date for a
  /// possibly-backdated notice record. NOT when the form was submitted if
  /// those differ.
  actionDate: Date
  /// The tenant's most recent protected act, or null if there is none on
  /// record. Only the MOST RECENT is needed - if the newest one is outside
  /// the window, every earlier one necessarily is too.
  mostRecentComplaint: RetaliationComplaint | null
  /// JurisdictionRule.retaliationWindowDays. Null means the state's window
  /// is not configured, and the guard is silent rather than guessing at a
  /// number nobody reviewed - the same call `graceUnknown` and
  /// `servicePermitted() === null` already make elsewhere in this product.
  windowDays: number | null
}

export interface RetaliationWarning {
  source: RetaliationSource
  sourceId: string
  description: string
  occurredAt: Date
  /// Whole days between the complaint and the action - always >= 0, since a
  /// complaint after the action date cannot be what the action was
  /// retaliating against.
  daysAgo: number
  windowDays: number
}

/**
 * Is `input.actionDate` inside the retaliation-presumption window opened by
 * the tenant's most recent protected act?
 *
 * Returns null - no warning - when: nothing is configured, there is no
 * complaint on record, the complaint is outside the window, or (defensively)
 * the complaint is dated AFTER the action, which cannot be what the action
 * retaliated against and would otherwise show as "-3 days ago", a number
 * that makes no sense on a warning banner.
 */
export function retaliationWarning(
  input: RetaliationCheckInput,
): RetaliationWarning | null {
  if (input.windowDays == null || input.mostRecentComplaint == null) return null

  const msPerDay = 24 * 60 * 60 * 1000
  const daysAgo = Math.floor(
    (input.actionDate.getTime() - input.mostRecentComplaint.occurredAt.getTime()) / msPerDay,
  )
  if (daysAgo < 0 || daysAgo > input.windowDays) return null

  return {
    source: input.mostRecentComplaint.source,
    sourceId: input.mostRecentComplaint.sourceId,
    description: input.mostRecentComplaint.description,
    occurredAt: input.mostRecentComplaint.occurredAt,
    daysAgo,
    windowDays: input.windowDays,
  }
}

/**
 * A separate check, called only when `retaliationWarning()` found one - same
 * shape as `packages/core/entry/validate.ts`'s `validateOverride`, and for
 * the same reason: a reason typed into a form that did not need one is
 * harmless, but a missing one on a form that DID need it is the difference
 * between a documented business justification and an undefended retaliation
 * claim.
 */
export function validateRetaliationAck(
  reason: string | null | undefined,
): Violation[] {
  if (!reason?.trim()) {
    return [
      {
        field: 'retaliationReason',
        message:
          'This is inside the retaliation-presumption window. State the business reason for going ahead - it is recorded.',
      },
    ]
  }
  return []
}
