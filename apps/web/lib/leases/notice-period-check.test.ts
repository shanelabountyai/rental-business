import { describe, expect, it } from 'vitest'
import { noticePeriodCheckFor } from './notice-period-check.ts'

// The database half of the notice-period guard (LEASE-11, R-066), against
// real Texas config (noticeToVacateDays: 30, seeded by packages/db/prisma/seed.mts).

const GIVEN = '2026-08-01'

describe('noticePeriodCheckFor', () => {
  it('passes cleanly at or above the configured period', async () => {
    const decision = await noticePeriodCheckFor({
      propertyState: 'TX',
      propertyCounty: null,
      givenOn: GIVEN,
      effectiveOn: '2026-08-31', // exactly 30 days
    })
    expect(decision.basis).toBe('within_limits')
    expect(decision.needsOverride).toBe(false)
  })

  it('needs override when short of the configured period', async () => {
    const decision = await noticePeriodCheckFor({
      propertyState: 'TX',
      propertyCounty: null,
      givenOn: GIVEN,
      effectiveOn: '2026-08-15', // 14 days
    })
    expect(decision.basis).toBe('insufficient_notice')
    expect(decision.needsOverride).toBe(true)
    expect(decision.requiredDays).toBe(30)
    expect(decision.shortfallDays).toBe(16)
  })

  it('fails open, not thrown, for a state with no JurisdictionRule configured', async () => {
    const decision = await noticePeriodCheckFor({
      propertyState: 'ZZ',
      propertyCounty: null,
      givenOn: GIVEN,
      effectiveOn: GIVEN, // zero notice - would need override if the rule applied
    })
    expect(decision.basis).toBe('within_limits')
    expect(decision.needsOverride).toBe(false)
  })
})
