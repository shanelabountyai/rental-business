import { describe, expect, it } from 'vitest'
import { formatPlatformFee, platformFeeCents, platformFeePercent, platformFeeRefusal } from './platform-fee.ts'

describe('platform fee (R-296, D-322)', () => {
  it('takes basis points of the amount, rounded half up to the cent', () => {
    expect(platformFeeCents(150_000, 250)).toBe(3_750)
    expect(platformFeeCents(1_001, 250)).toBe(25) // 25.025
    expect(platformFeeCents(1_020, 250)).toBe(26) // 25.5 → 26
  })

  it('takes nothing at zero, on nothing, or on a non-integer amount', () => {
    expect(platformFeeCents(150_000, 0)).toBe(0)
    expect(platformFeeCents(0, 250)).toBe(0)
    expect(platformFeeCents(-500, 250)).toBe(0)
    expect(platformFeeCents(10.5, 250)).toBe(0)
  })

  it('sends Stripe a percentage with at most two decimals', () => {
    expect(platformFeePercent(250)).toBe(2.5)
    expect(platformFeePercent(1)).toBe(0.01)
    expect(platformFeePercent(1000)).toBe(10)
    expect(formatPlatformFee(125)).toBe('1.25%')
  })

  it('refuses anything that is not 0-1000 whole basis points', () => {
    for (const ok of ['0', '250', '1000']) expect(platformFeeRefusal(ok), ok).toBeNull()
    for (const bad of ['', '-1', '2.5', '1001', '99999', 'abc', ' 25']) expect(platformFeeRefusal(bad), bad).not.toBeNull()
  })
})
