import { describe, expect, it } from 'vitest'
import {
  FUNNEL_STAGES,
  type ProspectJourney,
  funnelSteps,
  leadsBySource,
  sourceQuality,
} from './funnel.ts'

const AT = (day: number) => new Date(Date.UTC(2026, 2, day))

function journey(overrides: Partial<ProspectJourney> = {}): ProspectJourney {
  return {
    prospectId: `pro_${Math.random().toString(36).slice(2, 8)}`,
    source: 'direct',
    showedAt: null,
    appliedAt: null,
    approvedAt: null,
    ...overrides,
  }
}

describe('funnelSteps', () => {
  it('lists every stage even at zero', () => {
    const steps = funnelSteps([])
    expect(steps.map((step) => step.stage)).toEqual([...FUNNEL_STAGES])
    expect(steps.every((step) => step.count === 0)).toBe(true)
  })

  it('counts people, not events', () => {
    // One prospect, whatever happened along the way. The caller collapses
    // three bookings into one `showedAt`; this asserts the shape that makes
    // that collapsing meaningful.
    const steps = funnelSteps([journey({ showedAt: AT(1) })])
    expect(steps[1].count).toBe(1)
  })

  it('measures conversion within the cohort that reached the earlier stage', () => {
    // Four inquiries; two viewed; one of those two applied.
    const steps = funnelSteps([
      journey(),
      journey(),
      journey({ showedAt: AT(1) }),
      journey({ showedAt: AT(2), appliedAt: AT(5) }),
    ])
    expect(steps[1]).toMatchObject({ count: 2, conversion: 0.5, skipped: 0 })
    expect(steps[2]).toMatchObject({ count: 1, conversion: 0.5, skipped: 0 })
  })

  it('never reports a conversion above 100% when somebody skipped a stage', () => {
    // THE POINT OF THE COHORT RULE. One prospect viewed and did not apply;
    // two applied without any showing recorded. Naive
    // applications-over-showings is 200%, which reads as a broken report
    // rather than as the true and ordinary fact that people apply without
    // booking a viewing first.
    const steps = funnelSteps([
      journey({ showedAt: AT(1) }),
      journey({ appliedAt: AT(3) }),
      journey({ appliedAt: AT(4) }),
    ])
    expect(steps[2].count).toBe(2)
    expect(steps[2].conversion).toBe(0)
    expect(steps[2].skipped).toBe(2)
    expect(steps[2].conversion).toBeLessThanOrEqual(1)
  })

  it('reports null conversion, never zero, when nobody reached the previous stage', () => {
    const steps = funnelSteps([journey(), journey()])
    // Two people really did inquire and really did not view, so 0% here is a
    // true claim about real people and must NOT be null.
    expect(steps[1].conversion).toBe(0)
    // Nobody reached `showing`, so there is no cohort to have dropped out of.
    // Zero would read as "everybody who viewed failed to apply", which is a
    // claim about people who do not exist.
    expect(steps[2].conversion).toBeNull()
    expect(steps[3].conversion).toBeNull()
  })

  it('counts a stage reached even when the earlier one never was', () => {
    const steps = funnelSteps([journey({ approvedAt: AT(9) })])
    expect(steps[3].count).toBe(1)
    expect(steps[3].skipped).toBe(1)
  })
})

describe('sourceQuality', () => {
  it('ranks by approval rate and breaks ties on volume, not upward', () => {
    // A channel with one inquiry and one approval is 100% and must not
    // outrank a channel doing real volume at the same rate.
    const rows = sourceQuality([
      journey({ source: 'tiny', approvedAt: AT(1) }),
      ...Array.from({ length: 4 }, () => journey({ source: 'big', approvedAt: AT(1) })),
    ])
    expect(rows.map((row) => row.source)).toEqual(['big', 'tiny'])
    expect(rows[0].approvalRate).toBe(1)
  })

  it('counts each stage per source', () => {
    const rows = sourceQuality([
      journey({ source: 'zillow', showedAt: AT(1), appliedAt: AT(2), approvedAt: AT(3) }),
      journey({ source: 'zillow', showedAt: AT(1) }),
      journey({ source: 'direct' }),
    ])
    const zillow = rows.find((row) => row.source === 'zillow')
    expect(zillow).toMatchObject({ inquiries: 2, showings: 2, applications: 1, approvals: 1 })
    expect(zillow?.approvalRate).toBe(0.5)
    expect(rows.find((row) => row.source === 'direct')).toMatchObject({
      inquiries: 1,
      approvals: 0,
      approvalRate: 0,
    })
  })
})

describe('leadsBySource', () => {
  it('counts anonymous visits and sorts by volume', () => {
    expect(
      leadsBySource([
        { source: 'zillow' },
        { source: 'direct' },
        { source: 'zillow' },
        { source: 'zillow' },
      ]),
    ).toEqual([
      { source: 'zillow', visits: 3 },
      { source: 'direct', visits: 1 },
    ])
  })
})
