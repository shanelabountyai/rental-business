import { describe, expect, it } from 'vitest'
import {
  MAX_PLAN_INSTALMENTS,
  monthlyInstalments,
  planProgress,
  validatePlanTerms,
} from './plan.ts'

describe('monthlyInstalments', () => {
  it('sums to the total exactly, with the odd cents earliest', () => {
    const rows = monthlyInstalments({ totalCents: 100_00, count: 3, firstDueOn: '2026-03-01' })
    expect(rows.map((r) => r.amountCents)).toEqual([3334, 3333, 3333])
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(100_00)
  })

  it('steps months from the ORIGINAL day, clamping only where the month is short', () => {
    const rows = monthlyInstalments({ totalCents: 300, count: 4, firstDueOn: '2026-01-31' })
    expect(rows.map((r) => r.dueOn)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
  })

  it('rolls into the next year', () => {
    const rows = monthlyInstalments({ totalCents: 300, count: 3, firstDueOn: '2026-11-15' })
    expect(rows.map((r) => r.dueOn)).toEqual(['2026-11-15', '2026-12-15', '2027-01-15'])
  })

  it('refuses terms it cannot write', () => {
    expect(validatePlanTerms({ totalCents: 0, count: 3, firstDueOn: '2026-03-01' })).toHaveLength(1)
    expect(
      validatePlanTerms({ totalCents: 100, count: MAX_PLAN_INSTALMENTS + 1, firstDueOn: '2026-03-01' }),
    ).toHaveLength(1)
    expect(validatePlanTerms({ totalCents: 100, count: 3, firstDueOn: 'March' })).toHaveLength(1)
  })
})

describe('planProgress', () => {
  const schedule = monthlyInstalments({ totalCents: 900, count: 3, firstDueOn: '2026-03-01' })

  it('is on track before the first instalment matures, even with nothing paid', () => {
    const progress = planProgress({ instalments: schedule, paidCents: 0, asOf: '2026-03-01' })
    expect(progress.status).toBe('ACTIVE')
    expect(progress.dueToDateCents).toBe(0)
    expect(progress.nextDueOn).toBe('2026-03-01')
  })

  it('holds the plan through its grace period and breaks the day after', () => {
    expect(planProgress({ instalments: schedule, paidCents: 0, asOf: '2026-03-04' }).status).toBe(
      'ACTIVE',
    )
    const broken = planProgress({ instalments: schedule, paidCents: 0, asOf: '2026-03-05' })
    expect(broken.status).toBe('BROKEN')
    expect(broken.missedDueOn).toBe('2026-03-01')
    expect(broken.shortfallCents).toBe(300)
  })

  it('counts payments cumulatively rather than instalment by instalment', () => {
    // Two part payments covering the first instalment between them. A rule
    // hunting for one payment of exactly 300 would call this broken.
    const kept = planProgress({ instalments: schedule, paidCents: 300, asOf: '2026-03-20' })
    expect(kept.status).toBe('ACTIVE')
    expect(kept.nextDueOn).toBe('2026-04-01')

    // And paying ahead keeps the plan through a month with nothing in it.
    const ahead = planProgress({ instalments: schedule, paidCents: 600, asOf: '2026-04-20' })
    expect(ahead.status).toBe('ACTIVE')
    expect(ahead.shortfallCents).toBe(0)
  })

  it('breaks on the FIRST instalment the money did not reach, not the latest', () => {
    const progress = planProgress({ instalments: schedule, paidCents: 250, asOf: '2026-05-20' })
    expect(progress.missedDueOn).toBe('2026-03-01')
    expect(progress.shortfallCents).toBe(650)
  })

  it('completes on the full total even when an instalment arrived late', () => {
    const progress = planProgress({ instalments: schedule, paidCents: 900, asOf: '2026-09-01' })
    expect(progress.status).toBe('COMPLETED')
    expect(progress.remainingCents).toBe(0)
    expect(progress.nextDueOn).toBeNull()
    expect(progress.missedDueOn).toBeNull()
  })

  it('reads its instalments in date order however they arrive', () => {
    const shuffled = [...schedule].reverse()
    expect(planProgress({ instalments: shuffled, paidCents: 250, asOf: '2026-05-20' }).missedDueOn).toBe(
      '2026-03-01',
    )
  })
})
