import { describe, expect, it } from 'vitest'
import { earlierUndecidedApplications, type CompletedApplicationRef } from './order.ts'

function ref(overrides: Partial<CompletedApplicationRef> = {}): CompletedApplicationRef {
  return {
    applicationId: 'a1',
    completedAt: new Date('2026-08-01T00:00:00Z'),
    decided: false,
    ...overrides,
  }
}

describe('earlierUndecidedApplications', () => {
  it('is empty when nothing else completed earlier', () => {
    const target = ref({ applicationId: 'target', completedAt: new Date('2026-08-01T00:00:00Z') })
    const others = [ref({ applicationId: 'later', completedAt: new Date('2026-08-05T00:00:00Z') })]
    expect(earlierUndecidedApplications(target, others)).toEqual([])
  })

  it('flags an earlier-completed, still-undecided application', () => {
    const target = ref({ applicationId: 'target', completedAt: new Date('2026-08-05T00:00:00Z') })
    const others = [
      ref({ applicationId: 'earlier', completedAt: new Date('2026-08-01T00:00:00Z'), decided: false }),
    ]
    expect(earlierUndecidedApplications(target, others)).toEqual(['earlier'])
  })

  it('does not flag an earlier one that has already been decided', () => {
    const target = ref({ applicationId: 'target', completedAt: new Date('2026-08-05T00:00:00Z') })
    const others = [
      ref({ applicationId: 'earlier', completedAt: new Date('2026-08-01T00:00:00Z'), decided: true }),
    ]
    expect(earlierUndecidedApplications(target, others)).toEqual([])
  })
})
