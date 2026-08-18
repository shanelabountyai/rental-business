import { describe, expect, it } from 'vitest'
import { adverseActionNoticeText, adverseActionOwed } from './adverse-action.ts'

describe('adverseActionNoticeText', () => {
  const base = {
    applicantName: 'Jordan Blake',
    addressLine1: '12 Main St',
    agencyContact: 'Simulated Consumer Reporting Agency\n1 Bureau Way\n(800) 555-0100',
    factors: ['A record was found within the 84-month lookback.'],
    decisionNotes: 'Two evictions in the last year.',
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

  it('is marked as an unreviewed draft', () => {
    const text = adverseActionNoticeText({ ...base, decision: 'DECLINED' })
    expect(text).toMatch(/not been reviewed by an attorney/)
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
