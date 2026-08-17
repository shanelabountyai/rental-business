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
// habitability ticket and the configured window; this decides whether that
// fact falls inside it and what to say about it if so.

interface Violation {
  field: string
  message: string
}

export interface RetaliationComplaint {
  ticketId: string
  /// The free-text category a ticket carries (Ticket.category), not a
  /// closed enum - shown verbatim in the warning, matching D-10's rule that
  /// nothing tenant- or staff-facing surfaces an internal code unexplained.
  category: string
  occurredAt: Date
}

export interface RetaliationCheckInput {
  /// When the adverse action is actually taking effect - `new Date()` for a
  /// rent change happening now, or the notice's own `givenOn` date for a
  /// possibly-backdated notice record. NOT when the form was submitted if
  /// those differ.
  actionDate: Date
  /// The tenant's most recent habitability-flagged ticket, or null if there
  /// is none on record. Only the MOST RECENT is needed - if the newest one
  /// is outside the window, every earlier one necessarily is too.
  mostRecentComplaint: RetaliationComplaint | null
  /// JurisdictionRule.retaliationWindowDays. Null means the state's window
  /// is not configured, and the guard is silent rather than guessing at a
  /// number nobody reviewed - the same call `graceUnknown` and
  /// `servicePermitted() === null` already make elsewhere in this product.
  windowDays: number | null
}

export interface RetaliationWarning {
  ticketId: string
  category: string
  occurredAt: Date
  /// Whole days between the complaint and the action - always >= 0, since a
  /// complaint after the action date cannot be what the action was
  /// retaliating against.
  daysAgo: number
  windowDays: number
}

/**
 * Is `input.actionDate` inside the retaliation-presumption window opened by
 * the tenant's most recent habitability complaint?
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
    ticketId: input.mostRecentComplaint.ticketId,
    category: input.mostRecentComplaint.category,
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
