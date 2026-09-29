import { describe, expect, it } from 'vitest'
import { adverseActionNoticeText, adverseActionOwed, disclosedKeyFactors } from './adverse-action.ts'

describe('adverseActionNoticeText', () => {
  const base = {
    applicantName: 'Jordan Blake',
    addressLine1: '12 Main St',
    agencyContact: 'Simulated Consumer Reporting Agency\n1 Bureau Way\n(800) 555-0100',
    factors: ['A record was found within the 84-month lookback.'],
    decisionNotes: 'Two evictions in the last year.',
    creditScore: null,
  }
  const score = {
    score: 580,
    rangeLow: 300,
    rangeHigh: 850,
    keyFactors: ['Delinquency on accounts', 'Too many accounts with balances'],
    scoredOn: '2026-09-15',
    source: 'Example scoring model',
  }

  it('names the CRA verbatim and states it did not make the decision', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(text).toContain(base.agencyContact)
    expect(text).toContain('did not make this decision')
  })

  it('states the free-report and dispute rights', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(text).toMatch(/free copy of your report/)
    expect(text).toMatch(/60 days/)
    expect(text).toMatch(/dispute the accuracy/)
  })

  it('reflects a decline vs a conditional approval in the decision line', () => {
    const declined = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(declined).toMatch(/unable to offer you a lease/)
    const conditional = adverseActionNoticeText({ ...base, decision: 'APPROVED_WITH_CONDITIONS' })
    expect(conditional).toMatch(/different or additional conditions/)
  })

  it('reproduces the factors and decision notes, never computes new ones', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(text).toContain(base.factors[0])
    expect(text).toContain(base.decisionNotes)
  })

  it('omits the factors section entirely when there are none', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED', factors: [] })
    expect(text).not.toMatch(/Factors from the report/)
  })

  it('discloses the score, range, date, source and key factors when a score was used (LEGAL-02)', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED', creditScore: score })
    expect(text).toContain('Your credit score: 580')
    expect(text).toContain('Scores range from 300 to 850.')
    expect(text).toContain('Date of the score: 15 Sept 2026')
    expect(text).toContain('Scoring model or source: Example scoring model')
    expect(text).toContain('- Delinquency on accounts')
    expect(text).toContain('- Too many accounts with balances')
  })

  it('says a missing disclosure fact was not reported, rather than dropping the line', () => {
    const text = adverseActionNoticeText({
      ...base,
      decision: 'DECLINED',
      creditScore: { score: 580, rangeLow: null, rangeHigh: null, keyFactors: [], scoredOn: null, source: null },
    })
    expect(text).toContain('Your credit score: 580')
    expect(text).toMatch(/Range of possible scores: not reported by the agency/)
    expect(text).toMatch(/Date of the score: not reported by the agency/)
    expect(text).toMatch(/Scoring model or source: not reported by the agency/)
  })

  it('omits the score block when the report carried no score', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(text).not.toMatch(/credit score/i)
  })

  it('is marked as an unreviewed draft', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(text).toMatch(/not been reviewed by an attorney/)
  })
})

describe('disclosedKeyFactors', () => {
  const six = ['a', 'b', 'c', 'd', 'Number of recent inquiries', 'f']

  it('caps the list at four', () => {
    expect(disclosedKeyFactors(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('adds inquiries as a fifth when it falls outside the first four', () => {
    expect(disclosedKeyFactors(six)).toEqual(['a', 'b', 'c', 'd', 'Number of recent inquiries'])
  })

  it('does not add a fifth when inquiries is already in the first four', () => {
    expect(disclosedKeyFactors(['a', 'Too many inquiries', 'c', 'd', 'e'])).toEqual([
      'a',
      'Too many inquiries',
      'c',
      'd',
    ])
  })
})

describe('adverseActionOwed', () => {
  it('owes nothing for a plain APPROVED', () => {
    expect(
      adverseActionOwed({ decision: 'APPROVED', noticeSentAt: null, overriddenAt: null }),
    ).toBe(false)
  })

  it('owes nothing for an undecided applicant', () => {
    expect(adverseActionOwed({ decision: null, noticeSentAt: null, overriddenAt: null })).toBe(
      false,
    )
  })

  it('owes a notice for a fresh DECLINED', () => {
    expect(
      adverseActionOwed({ decision: 'DECLINED', noticeSentAt: null, overriddenAt: null }),
    ).toBe(true)
  })

  it('owes a notice for a fresh APPROVED_WITH_CONDITIONS', () => {
    expect(
      adverseActionOwed({
        decision: 'APPROVED_WITH_CONDITIONS',
        noticeSentAt: null,
        overriddenAt: null,
      }),
    ).toBe(true)
  })

  it('is satisfied once the notice is sent', () => {
    expect(
      adverseActionOwed({ decision: 'DECLINED', noticeSentAt: new Date(), overriddenAt: null }),
    ).toBe(false)
  })

  it('is satisfied by an override even with no notice sent', () => {
    expect(
      adverseActionOwed({ decision: 'DECLINED', noticeSentAt: null, overriddenAt: new Date() }),
    ).toBe(false)
  })
})
