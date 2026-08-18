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

  results.push({
    key: 'eviction',
    result:
      facts.evictionRecordFound == null
        ? 'UNKNOWN'
        : facts.evictionRecordFound
          ? 'FAILS'
          : 'MEETS',
    detail:
      facts.evictionRecordFound == null
        ? 'No report yet.'
        : facts.evictionRecordFound
          ? `A record was found within the ${criteria.evictionLookbackMonths}-month lookback - requires individualized assessment.`
          : `No record within the ${criteria.evictionLookbackMonths}-month lookback.`,
  })

  results.push({
    key: 'criminal',
    result:
      facts.criminalRecordFound == null
        ? 'UNKNOWN'
        : facts.criminalRecordFound
          ? 'FAILS'
          : 'MEETS',
    detail:
      facts.criminalRecordFound == null
        ? 'No report yet.'
        : facts.criminalRecordFound
          ? `A record was found within the ${criteria.criminalLookbackMonths}-month lookback - requires individualized assessment, not an automatic decline.`
          : `No record within the ${criteria.criminalLookbackMonths}-month lookback.`,
  })

  return results
}
