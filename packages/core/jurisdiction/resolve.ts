// The one decision every statutory number in the product routes through
// (D-4): given every candidate rule row for a state, which single row governs
// a property on a given day. Pure and DB-free, matching
// packages/core/scheduling's own rule for the same reason - the caller reads
// the rows, this decides among them, and the decision has unit tests that
// need no database.
//
// apps/web/lib/jurisdiction/queries.ts is the actual `rulesFor(property,
// asOf)` the backlog names - it fetches candidates and calls this.

export interface JurisdictionRuleLike {
  jurisdiction: string | null
  effectiveFrom: Date
  effectiveTo: Date | null
}

function normalizeJurisdiction(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  return trimmed ? trimmed : null
}

/**
 * A local ordinance is a full config row, not a diff against the state row
 * (D-4: "adding a jurisdiction = adding a reviewed config record"), so this
 * never merges fields across rows - it picks the one row that governs, in
 * full.
 *
 * Local beats statewide whenever a local row is actually in force on `asOf`.
 * A county row that has not taken effect yet, or has been repealed, correctly
 * falls back to the statewide rule for that same day rather than returning
 * nothing - "no county-specific rule right now" is not "no rule at all".
 */
export function selectApplicableRule<T extends JurisdictionRuleLike>(
  candidates: readonly T[],
  county: string | null | undefined,
  asOf: Date,
): T | null {
  const activeFor = (jurisdictionKey: string | null): T | null => {
    let best: T | null = null
    for (const rule of candidates) {
      if (normalizeJurisdiction(rule.jurisdiction) !== jurisdictionKey) continue
      if (rule.effectiveFrom > asOf) continue
      if (rule.effectiveTo != null && asOf > rule.effectiveTo) continue
      if (!best || rule.effectiveFrom > best.effectiveFrom) best = rule
    }
    return best
  }

  const countyKey = normalizeJurisdiction(county)
  return (countyKey && activeFor(countyKey)) || activeFor(null)
}
