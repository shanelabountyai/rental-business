// FCRA adverse-action notice text (LEASE-05, R-061).
//
// 15 U.S.C. § 1681m(a): anyone who takes adverse action based in whole or
// part on a consumer report must tell the consumer (1) the name, address
// and phone number of the CRA that furnished it, (2) that the CRA did not
// make the decision and cannot explain the specific reasons for it, and (3)
// the consumer's right to a free copy of the report from that CRA within 60
// days and to dispute its accuracy or completeness directly with the CRA.
// "Approve with conditions" is adverse action too - a worse offer than
// applied for, because of the report, is exactly what the statute means by
// it.
//
// A DRAFT, like every legal artifact this product generates (D-4's closing
// line, entryNoticeText's own precedent) - not reviewed by counsel, and it
// says so in its own last line.
//
// WHAT THIS IS NOT: a scoring explanation. `factors` below is the plain
// language evaluateCriteria() already wrote for each FAILS/UNKNOWN
// criterion - reproduced, never computed here. No AI or algorithmic
// applicant scoring, ever (LEASE-04's rule, restated for the one document
// that could otherwise smuggle a "risk score" back in through the notice).
//
// THE CREDIT-SCORE DISCLOSURE (LEGAL-02, D-276) is § 1681m(a)(2): when a
// numerical credit score was used, the notice must state it together with
// § 1681g(f)(1)(B)-(E) - the model's possible range, up to four key factors
// that hurt it (five when inquiries is one of them but not in the first
// four), the date it was created, and who provided it. Every one of those
// is the provider's own figure, reproduced; none is computed here.

import { friendlyBusinessDate, type BusinessDate } from '../scheduling/local-time.ts'

/// What the provider reported about the score itself. Any piece it did not
/// report is null (reports ordered before LEGAL-02 carry the score alone),
/// and the notice says so rather than leaving the line out.
export interface CreditScoreDisclosure {
  score: number
  rangeLow: number | null
  rangeHigh: number | null
  /// In the provider's own order, most significant first.
  keyFactors: readonly string[]
  scoredOn: BusinessDate | null
  source: string | null
}

export interface AdverseActionContext {
  applicantName: string
  addressLine1: string
  /// APPROVED_WITH_CONDITIONS or DECLINED - never APPROVED (no adverse
  /// action is owed for a plain approval, and this function is not called
  /// for one).
  decision: 'APPROVED_WITH_CONDITIONS' | 'DECLINED'
  /// The reporting agency's own identity, as the adapter returned it and
  /// ScreeningReport.agencyContact froze it at order time - reproduced
  /// verbatim, § 1681m(a)(1)'s requirement.
  agencyContact: string
  /// Plain-language statements for whichever criteria did not MEET,
  /// reproduced from evaluateCriteria() - "considered in this decision",
  /// never "the reason", since the statute requires naming the CRA and the
  /// right to dispute, not a itemized rationale.
  factors: readonly string[]
  /// The individualized-assessment note a staff member wrote when deciding
  /// (ScreeningReport.decisionNotes) - HUD's guidance on criminal-history
  /// screening is why this exists at all; reproduced here so the applicant
  /// sees the same reasoning the decision was actually based on.
  decisionNotes: string | null
  /// Null when the report carried no score - the block is then omitted.
  creditScore: CreditScoreDisclosure | null
}

/// § 1681g(f)(1)(C): no more than four factors, except that inquiries must
/// be listed as a fifth when they are a key factor but not in the first four.
export function disclosedKeyFactors(factors: readonly string[]): string[] {
  const firstFour = factors.slice(0, 4)
  const inquiries = factors.slice(4).find((f) => /inquir/i.test(f))
  return inquiries ? [...firstFour, inquiries] : firstFour
}

const NOT_REPORTED = 'not reported by the agency - you may request it from the agency named above'

function creditScoreLines(d: CreditScoreDisclosure): string[] {
  const factors = disclosedKeyFactors(d.keyFactors)
  return [
    '',
    'Your credit score',
    '',
    'We also obtained a credit score from the agency named above and used it in making this decision.',
    '',
    `Your credit score: ${d.score}`,
    d.rangeLow != null && d.rangeHigh != null
      ? `Scores range from ${d.rangeLow} to ${d.rangeHigh}.`
      : `Range of possible scores: ${NOT_REPORTED}`,
    `Date of the score: ${d.scoredOn ? friendlyBusinessDate(d.scoredOn) : NOT_REPORTED}`,
    `Scoring model or source: ${d.source ?? NOT_REPORTED}`,
    '',
    'Key factors that adversely affected your credit score:',
    ...(factors.length > 0 ? factors.map((f) => `- ${f}`) : [`- ${NOT_REPORTED}`]),
  ]
}

/// What the compliance gate needs to know about ONE applicant's screening
/// outcome - shared by the automatic SCREENED→APPROVED advance
/// (staff-actions.ts) and the manual override gate on advanceProspectStage
/// (prospects/staff-actions.ts), so "is an adverse action still owed" is
/// answered identically in both places rather than drifting.
export interface AdverseActionStatus {
  decision: string | null
  /// Notice.servedAt for the adverse-action notice, if one exists and has
  /// been served.
  noticeSentAt: Date | null
  /// ScreeningReport.adverseActionOverriddenAt - the escape hatch.
  overriddenAt: Date | null
}

/**
 * True when this applicant's decision requires an adverse-action notice
 * (DECLINED or APPROVED_WITH_CONDITIONS) and neither the notice has been
 * sent nor the block overridden with a reason. A plain APPROVED, or an
 * undecided applicant, owes nothing.
 */
export function adverseActionOwed(status: AdverseActionStatus): boolean {
  if (status.decision !== 'DECLINED' && status.decision !== 'APPROVED_WITH_CONDITIONS') {
    return false
  }
  return status.noticeSentAt == null && status.overriddenAt == null
}

export function adverseActionNoticeText(context: AdverseActionContext): string {
  const decisionLine =
    context.decision === 'DECLINED'
      ? 'we are unable to offer you a lease for this property'
      : 'we can only offer you a lease for this property under different or additional conditions than you applied for'

  return [
    'Notice of adverse action',
    '',
    `Dear ${context.applicantName},`,
    '',
    `Based in whole or in part on information in a consumer report, ${decisionLine} at ${context.addressLine1}.`,
    '',
    'The consumer reporting agency that furnished the report was:',
    '',
    context.agencyContact,
    '',
    'That agency did not make this decision and is unable to explain the specific reasons for it.',
    '',
    'You have the right to obtain a free copy of your report from that agency if you request it within 60 days of this notice, and the right to dispute the accuracy or completeness of any information the agency furnished, directly with the agency.',
    ...(context.creditScore ? creditScoreLines(context.creditScore) : []),
    ...(context.factors.length > 0
      ? ['', 'Factors from the report considered in this decision:', ...context.factors.map((f) => `- ${f}`)]
      : []),
    ...(context.decisionNotes ? ['', `Notes on this decision: ${context.decisionNotes}`] : []),
    '',
    '— This notice is a draft generated by the property management system and has not been reviewed by an attorney. It is not legal advice.',
  ].join('\n')
}
