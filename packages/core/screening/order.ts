// "Order-of-completed-application enforced or deviation logged" (LEASE-04,
// R-060). A pure function over what the caller already looked up, so the
// rule itself - "nothing earlier-completed and still undecided may be
// skipped without saying why" - is provable with no database at all.
// apps/web/lib/screening/staff-actions.ts does the looking-up and calls
// `audit()` with 'application_order.deviated' (REASON_REQUIRED) when this
// returns a non-empty list and no deviation reason was given.

export interface CompletedApplicationRef {
  applicationId: string
  completedAt: Date
  /// True once every applicant under this Application has a screening
  /// decision recorded - not merely screened.
  decided: boolean
}

/**
 * Applications for the same listing that completed before `target` and are
 * still undecided - deciding `target` ahead of any of these is an
 * out-of-order deviation.
 */
export function earlierUndecidedApplications(
  target: CompletedApplicationRef,
  others: readonly CompletedApplicationRef[],
): string[] {
  return others
    .filter((o) => o.completedAt.getTime() < target.completedAt.getTime() && !o.decided)
    .map((o) => o.applicationId)
}
