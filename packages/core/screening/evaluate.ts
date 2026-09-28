// Criteria comparison (LEASE-04, R-060).
//
// NO AI OR ALGORITHMIC APPLICANT SCORING, EVER - the backlog's own words.
// `evaluateCriteria` returns one independent MEETS/FAILS/UNKNOWN verdict per
// criterion, side by side with what the criteria required, for a human to
// read - "results displayed alongside criteria". It never combines them
// into a composite score or a recommended decision. `decision` lives only
// on ScreeningReport, and only a staff member ever writes to it
// (apps/web/lib/screening/staff-actions.ts).
//
// A criminal or eviction record found inside the lookback window is FAILS,
// never an automatic decline - HUD's 2016 guidance on criminal-history
// screening is why ScreeningReport carries a required `decisionNotes` field
// for anything but a plain approval: nature, severity and time elapsed have
// to be weighed by a person looking at this table, not by this function.
//
// "WITHIN THE LOOKBACK" IS SAID ONLY WHEN A DATE BACKS IT (LEGAL-01). The
// window is configured on ScreeningCriteria, but a bare "record found"
// boolean carries no date, and this function used to write "found within
// the 84-month lookback" for it anyway - straight into the FCRA notice. A
// 12-year-old eviction was described as inside a 7-year window. The
// provider now returns the date of the most recent record and the window is
// checked HERE (D-12's "core decides"), not trusted to the provider: an
// undated record is UNKNOWN, a record older than the window is MEETS.

import { friendlyBusinessDate, subtractMonths, type BusinessDate } from '../scheduling/local-time.ts'

export interface ScreeningCriteriaConfig {
  version: number
  incomeToRentMultiplierX100: number
  minCreditScore: number | null
  evictionLookbackMonths: number
  criminalLookbackMonths: number
}

export interface ScreeningFacts {
  monthlyIncomeCents: number | null
  rentCents: number
  creditScore: number | null
  evictionRecordFound: boolean | null
  criminalRecordFound: boolean | null
  /// The most recent record's date, as the provider reported it. Null when
  /// no record was found, or when one was found with no date.
  evictionRecordOn: BusinessDate | null
  criminalRecordOn: BusinessDate | null
  /// The day the lookback is measured back from - the decision date, or
  /// today for an undecided applicant.
  asOf: BusinessDate
}

export type CriterionResult = 'MEETS' | 'FAILS' | 'UNKNOWN'

export interface CriterionEvaluation {
  key: 'income' | 'credit' | 'eviction' | 'criminal'
  result: CriterionResult
  /// Plain-language statement of what was required and what was found -
  /// what the "alongside criteria" display actually renders.
  detail: string
}

export function evaluateCriteria(
  criteria: ScreeningCriteriaConfig,
  facts: ScreeningFacts,
): CriterionEvaluation[] {
  const results: CriterionEvaluation[] = []

  const requiredIncomeCents = Math.ceil(
    (facts.rentCents * criteria.incomeToRentMultiplierX100) / 100,
  )
  const multiplier = (criteria.incomeToRentMultiplierX100 / 100).toFixed(2)
  if (facts.monthlyIncomeCents == null) {
    results.push({
      key: 'income',
      result: 'UNKNOWN',
      detail: `No income reported; ${multiplier}x rent required.`,
    })
  } else {
    results.push({
      key: 'income',
      result: facts.monthlyIncomeCents >= requiredIncomeCents ? 'MEETS' : 'FAILS',
      detail: `Reported income requires ${multiplier}x rent (${requiredIncomeCents}c); applicant reported ${facts.monthlyIncomeCents}c.`,
    })
  }

  if (criteria.minCreditScore == null) {
    results.push({ key: 'credit', result: 'UNKNOWN', detail: 'No credit floor configured.' })
  } else if (facts.creditScore == null) {
    results.push({
      key: 'credit',
      result: 'UNKNOWN',
      detail: `Floor is ${criteria.minCreditScore}; no score reported yet.`,
    })
  } else {
    results.push({
      key: 'credit',
      result: facts.creditScore >= criteria.minCreditScore ? 'MEETS' : 'FAILS',
      detail: `Floor is ${criteria.minCreditScore}; reported score is ${facts.creditScore}.`,
    })
  }

  results.push(
    recordCriterion('eviction', facts.evictionRecordFound, facts.evictionRecordOn, criteria.evictionLookbackMonths, facts.asOf, ' - requires individualized assessment.'),
  )
  results.push(
    recordCriterion('criminal', facts.criminalRecordFound, facts.criminalRecordOn, criteria.criminalLookbackMonths, facts.asOf, ' - requires individualized assessment, not an automatic decline.'),
  )

  return results
}

function recordCriterion(
  key: 'eviction' | 'criminal',
  found: boolean | null,
  recordOn: BusinessDate | null,
  lookbackMonths: number,
  asOf: BusinessDate,
  assessment: string,
): CriterionEvaluation {
  const window = `${lookbackMonths}-month lookback`
  if (found == null) return { key, result: 'UNKNOWN', detail: 'No report yet.' }
  if (!found) return { key, result: 'MEETS', detail: `No record within the ${window}.` }
  if (recordOn == null) {
    return {
      key,
      result: 'UNKNOWN',
      detail: `A record was reported without a date, so it cannot be placed inside or outside the ${window}. Check the report itself.`,
    }
  }
  const on = friendlyBusinessDate(recordOn)
  // BusinessDate strings compare correctly as strings.
  if (recordOn < subtractMonths(asOf, lookbackMonths)) {
    return { key, result: 'MEETS', detail: `The most recent record (${on}) is outside the ${window}.` }
  }
  return { key, result: 'FAILS', detail: `A record dated ${on} was found within the ${window}${assessment}` }
}
