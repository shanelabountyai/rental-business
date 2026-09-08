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
  dayCountBasis: string | null
  observedHolidays: readonly string[]
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
    // R-182 (review finding 14). A state that does NOT count in plain
    // calendar days is a state where two checks in this product are still
    // wrong, and they are wrong quietly: `noticePeriodCheck` (LEASE-12) and
    // `renewalCheck` (LEASE-09) ask "were enough days given" by subtracting
    // two timestamps, so they count calendar days whatever this column says.
    // Every clock that ADDS days to produce a deadline goes through
    // `statutoryDeadline` and is correct. Saying so here is the cheap honest
    // fix that finding 15 argues for over building the thing: the gap is
    // loud, on the screen that gates a state going effective, rather than
    // silent in two functions nobody is going to re-read.
    const productLimits =
      rule.dayCountBasis != null && rule.dayCountBasis !== 'CALENDAR'
        ? [
            'notice-sufficiency checks (rent increase LEASE-09, notice to vacate LEASE-12) still count calendar days',
            ...(rule.observedHolidays.length === 0
              ? ['no observed holidays are on file, so only weekends are skipped']
              : []),
          ]
        : []

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
