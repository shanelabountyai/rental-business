import { describe, expect, it } from 'vitest'
import {
  ABANDONMENT_OUTCOMES,
  assessEvidence,
  type ContactMethod,
  type ContactOutcome,
  disposalReadiness,
  MIN_ATTEMPTS,
  MIN_DISTINCT_METHODS,
} from './index.ts'

const attempt = (method: ContactMethod, outcome: ContactOutcome = 'NO_ANSWER') => ({
  method,
  outcome,
})

describe('assessEvidence', () => {
  const solid = {
    attempts: [attempt('PHONE_CALL'), attempt('TEXT'), attempt('DOOR_KNOCK')],
    daysSinceContact: 21,
    presumedAfterDays: 14,
    rentUnpaid: true,
  }

  it('reports a solid case with no gaps', () => {
    const assessment = assessEvidence(solid)
    expect(assessment.attemptsSufficient).toBe(true)
    expect(assessment.statutoryPeriodMet).toBe(true)
    expect(assessment.gaps).toEqual([])
  })

  // The single most important branch: somebody answered. No amount of
  // arrears or silence afterwards makes a tenancy the tenant has responded
  // to an abandoned one.
  it('flags a case where somebody was actually REACHED', () => {
    const assessment = assessEvidence({
      ...solid,
      attempts: [attempt('PHONE_CALL'), attempt('TEXT', 'REACHED'), attempt('DOOR_KNOCK')],
    })
    expect(assessment.reached).toBe(true)
    expect(assessment.gaps[0]).toMatch(/is not abandoned/)
  })

  it('counts DISTINCT methods, not just attempts', () => {
    // Three phone calls is three attempts and one method. Somebody ringing
    // a disconnected number three times has not tried.
    const assessment = assessEvidence({
      ...solid,
      attempts: [attempt('PHONE_CALL'), attempt('PHONE_CALL'), attempt('PHONE_CALL')],
    })
    expect(assessment.attemptCount).toBe(3)
    expect(assessment.distinctMethods).toBe(1)
    expect(assessment.attemptsSufficient).toBe(false)
    expect(assessment.gaps.join(' ')).toMatch(/house rule, not a statute/)
  })

  it('names the house-rule bar it is applying', () => {
    expect(MIN_ATTEMPTS).toBe(3)
    expect(MIN_DISTINCT_METHODS).toBe(2)
  })

  it('flags a paid-up tenancy', () => {
    const assessment = assessEvidence({ ...solid, rentUnpaid: false })
    expect(assessment.gaps.join(' ')).toMatch(/paid up is not an abandoned one/)
  })

  it('reports an unconfigured state period as unknown, never as met', () => {
    // The same posture the cure clock and the grace period take: null is not
    // "no period applies", and it must not read as satisfied.
    const assessment = assessEvidence({ ...solid, presumedAfterDays: null })
    expect(assessment.periodUnknown).toBe(true)
    expect(assessment.statutoryPeriodMet).toBeNull()
    expect(assessment.gaps.join(' ')).toMatch(/not configured/)
  })

  it('reports a period that has not run', () => {
    const assessment = assessEvidence({ ...solid, daysSinceContact: 5 })
    expect(assessment.statutoryPeriodMet).toBe(false)
    expect(assessment.gaps.join(' ')).toMatch(/5 days since any sign/)
  })

  it('treats an unknown days-since-contact as not meeting the period', () => {
    const assessment = assessEvidence({ ...solid, daysSinceContact: null })
    expect(assessment.statutoryPeriodMet).toBe(false)
  })
})

describe('disposalReadiness — the one hard refusal', () => {
  const base = {
    heldFrom: '2026-08-01' as const,
    storageDays: 30,
    noticeDays: null,
    noticeSentOn: null,
    today: '2026-09-05' as const,
  }

  it('REFUSES when the state period is unconfigured — the one place unknown blocks', () => {
    // Everywhere else in this product an unconfigured rule warns and lets
    // the human decide. Disposal is the exception because it cannot be
    // undone: somebody's photographs in a skip are gone.
    const decision = disposalReadiness({ ...base, storageDays: null })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('period_unknown')
  })

  it('refuses while the storage period is still running', () => {
    const decision = disposalReadiness({ ...base, today: '2026-08-20' })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('still_storing')
    expect(decision.earliestOn).toBe('2026-08-31')
    expect(decision.daysRemaining).toBe(11)
  })

  it('is not lawful ON the day the period ends, and is the day after', () => {
    // 1 August + 30 days is 31 August. `today < storageEndsOn` refuses on the
    // 30th and allows on the 31st — the tenant gets the whole period.
    expect(disposalReadiness({ ...base, today: '2026-08-30' }).allowed).toBe(false)
    expect(disposalReadiness({ ...base, today: '2026-08-31' }).allowed).toBe(true)
  })

  it('allows it once the storage period has run and no notice is required', () => {
    const decision = disposalReadiness(base)
    expect(decision.allowed).toBe(true)
    expect(decision.earliestOn).toBe('2026-08-31')
  })

  it('treats notice as an ADDITIONAL requirement, not an alternative', () => {
    // Storage period done, but this state also wants notice and none was
    // sent. Allowing it here would let a state with a notice rule be
    // satisfied by waiting alone.
    const decision = disposalReadiness({ ...base, noticeDays: 15 })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('notice_not_sent')
  })

  it('refuses while the notice period itself is running', () => {
    const decision = disposalReadiness({
      ...base,
      noticeDays: 15,
      noticeSentOn: '2026-09-01',
      today: '2026-09-10',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.refusal).toBe('notice_period_running')
    expect(decision.earliestOn).toBe('2026-09-16')
  })

  it('allows it once both periods have run', () => {
    const decision = disposalReadiness({
      ...base,
      noticeDays: 15,
      noticeSentOn: '2026-09-01',
      today: '2026-09-16',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.earliestOn).toBe('2026-09-16')
  })

  it('ignores a configured notice period of zero', () => {
    // A state that says "no notice needed" configured as 0 must not fall
    // into the notice-not-sent branch for ever.
    expect(disposalReadiness({ ...base, noticeDays: 0 }).allowed).toBe(true)
  })
})

describe('outcomes', () => {
  it('leads with the tenant coming back', () => {
    // Same call the eviction outcomes make with CASH_FOR_KEYS: burying the
    // good outcome makes the product read as though abandonment were where
    // every quiet tenancy is heading.
    expect(ABANDONMENT_OUTCOMES[0]).toBe('TENANT_RETURNED')
  })
})
