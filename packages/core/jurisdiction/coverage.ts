// R-162 (review finding 11): "which of your states has no rule, and which
// has one with unreviewed fields" - a portfolio-wide predicate, so it is a
// pure function over values the caller fetched, not a live query (D-4's own
// pattern for selectApplicableRule, and the posture R-138's revokeRefusal
// finding demands for anything that reasons about "every row of this kind
// in the deployment": untestable end-to-end against a shared database with
// 1,700+ real rows in it, testable in one call here).

/// The tri-state legal booleans the schema itself already documents as
/// "null means nobody has reviewed this state yet" - not "not configured",
/// the same claim `reviewedBy` makes about the whole row. Nullable day
/// counts (abandonment, cure periods) are a different kind of gap - real
/// config still owed, but not a stalled legal question - and are left off
/// this list on purpose.
const UNREVIEWED_FIELDS = [
  { key: 'retaliationWindowDays', label: 'retaliation window (RISK-06)' },
  { key: 'sourceOfIncomeProtected', label: 'source-of-income protection (LEASE-01)' },
  { key: 'preMoveOutWalkthroughRequired', label: 'pre-move-out walkthrough right (INSP-02)' },
  { key: 'earlyTerminationRightExists', label: 'early-termination right (RISK-04)' },
  { key: 'acceptanceWaivesNotice', label: 'acceptance-of-rent waiver (PAY-14)' },
  { key: 'cureDemandMayIncludeFees', label: 'fees in a cure demand (PAY-14, R-194)' },
  { key: 'partialPaymentCures', label: 'partial payment as a cure (PAY-14, R-194)' },
  { key: 'dayCountBasis', label: 'how statutory days are counted (§6.7, R-182)' },
] as const

export interface RuleCoverageLike {
  state: string
  jurisdiction: string | null
  reviewedBy: string | null
  retaliationWindowDays: number | null
  sourceOfIncomeProtected: boolean | null
  preMoveOutWalkthroughRequired: boolean | null
  earlyTerminationRightExists: boolean | null
  acceptanceWaivesNotice: boolean | null
  cureDemandMayIncludeFees: boolean | null
  partialPaymentCures: boolean | null
  dayCountBasis: string | null
  observedHolidays: readonly string[]
  depositEscrowRequired: boolean
  depositInterestRequired: boolean
}

export interface CoverageGap {
  state: string
  jurisdiction: string | null
  unreviewedFields: string[]
  /// R-182: gaps that are not an unanswered legal question but a KNOWN limit
  /// of this product against an answer that HAS been given. Separate from
  /// `unreviewedFields` because the remedy is different - nobody can clear
  /// these by reading a statute, and a screen that mixed them would ask an
  /// operator to review something already reviewed.
  productLimits: string[]
}

export interface PortfolioCoverage {
  /// States with an active property and NO current rule at all - `rulesFor`
  /// throws for every property in one of these today.
  statesNeedingRule: string[]
  /// States that do have a current rule, but it (or the row itself) still
  /// carries an unreviewed legal question.
  gaps: CoverageGap[]
}

/**
 * `propertyStates` and `currentRules` are values the caller already fetched
 * (portfolio property states; `listCurrentRules`'s output) - this only
 * decides what to say about them.
 */
export function computeCoverage(
  propertyStates: readonly string[],
  currentRules: readonly RuleCoverageLike[],
): PortfolioCoverage {
  const configuredStates = new Set(currentRules.map((rule) => rule.state))
  const statesNeedingRule = [...new Set(propertyStates)]
    .filter((state) => !configuredStates.has(state))
    .sort()

  const gaps: CoverageGap[] = []
  for (const rule of currentRules) {
    const unreviewedFields = [
      ...(rule.reviewedBy ? [] : ['not yet reviewed by an attorney']),
      ...UNREVIEWED_FIELDS.filter(({ key }) => rule[key] == null).map(
        ({ label }) => label,
      ),
    ]
    // R-200 CLOSED THE FIRST HALF OF THIS (review finding 14), so the warning
    // it used to carry is GONE rather than reworded: `noticePeriodCheck`
    // (LEASE-12), `renewalRentCheck` (LEASE-09) and `assessEvidence`'s
    // presumption all count through `statutoryDeadline` now, so there is no
    // longer a check in this product that reads this column and ignores it.
    // A limit that has been fixed must not keep being announced - an operator
    // who clears a gap and sees the same sentence learns the screen is stale.
    //
    // The holiday warning survives and matters MORE than it did. Every one of
    // those checks now consults `observedHolidays`, so a business-day state
    // with an empty list silently counts a public holiday as a working day —
    // which shortens a notice period rather than lengthening it.
    const productLimits = [
      ...(rule.dayCountBasis != null &&
      rule.dayCountBasis !== 'CALENDAR' &&
      rule.observedHolidays.length === 0
        ? [
            'no observed holidays are on file, so only weekends are skipped when counting statutory days',
          ]
        : []),
      // R-183 (review finding 15). Both are FREE IN TEXAS, which requires
      // neither, and that is exactly why they survived unbuilt: the cost
      // arrives with the first state that requires one. Interest is the
      // sharper of the two - a disposition letter short by the interest owed
      // is what converts a routine deduction dispute into a statutory penalty
      // claim - so it is named in terms of the letter, not in terms of a
      // missing column.
      ...(rule.depositInterestRequired
        ? [
            'deposit interest is required here and nothing computes or accrues it, so a disposition letter would go out short by the interest owed (PAY-11)',
          ]
        : []),
      ...(rule.depositEscrowRequired
        ? [
            'deposits must be held in a separate account here and there is nowhere in this product to record which one (PAY-11)',
          ]
        : []),
    ]

    if (unreviewedFields.length > 0 || productLimits.length > 0) {
      gaps.push({
        state: rule.state,
        jurisdiction: rule.jurisdiction,
        unreviewedFields,
        productLimits,
      })
    }
  }

  return { statesNeedingRule, gaps }
}
