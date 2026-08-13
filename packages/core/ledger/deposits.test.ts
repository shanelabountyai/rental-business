import { describe, expect, it } from 'vitest'
import {
  type DepositRule,
  depositCapCents,
  depositHeldCents,
  depositObligations,
  validateDepositAmount,
} from './deposits.ts'

const texas: DepositRule = {
  // Texas sets no statutory ceiling on a residential deposit.
  depositMaxBps: null,
  depositEscrowRequired: false,
  depositInterestRequired: false,
}

/// A stricter state, of the kind this product is built to be configured for.
const strict: DepositRule = {
  // 15_000 bps = one and a half months' rent.
  depositMaxBps: 15_000,
  depositEscrowRequired: true,
  depositInterestRequired: true,
}

describe('depositCapCents', () => {
  it('is NULL where the state sets no ceiling, which is not the same as zero', () => {
    // The distinction the whole function exists for: reading null as 0 would
    // block every lease in Texas, and reading 0 as null would permit an
    // unlawful deposit wherever a state genuinely bans one.
    expect(depositCapCents(texas, 150_000)).toBeNull()
  })

  it('computes the ceiling from basis points of monthly rent', () => {
    expect(depositCapCents(strict, 150_000)).toBe(225_000)
    expect(depositCapCents({ ...strict, depositMaxBps: 10_000 }, 150_000)).toBe(150_000)
  })

  it('rounds DOWN, because a cap rounded up is a cap exceeded', () => {
    // 1,333 * 1.5 = 1,999.5 cents.
    expect(depositCapCents(strict, 1_333)).toBe(1_999)
  })
})

describe('validateDepositAmount', () => {
  it('permits any amount where the state sets no cap', () => {
    expect(
      validateDepositAmount({
        depositCents: 500_000,
        rentCents: 150_000,
        arrangement: 'CASH',
        rule: texas,
      }),
    ).toEqual([])
  })

  it('REFUSES a deposit over the statutory ceiling, and says what the ceiling is', () => {
    // Over-collecting is a violation on the day it is taken, and in several
    // states the remedy runs to multiples of the excess. The message carries
    // the number so somebody can fix it without going to look it up.
    const violations = validateDepositAmount({
      depositCents: 300_000,
      rentCents: 150_000,
      arrangement: 'CASH',
      rule: strict,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]!.message).toContain('$2,250.00')
  })

  it('allows a deposit exactly at the ceiling', () => {
    expect(
      validateDepositAmount({
        depositCents: 225_000,
        rentCents: 150_000,
        arrangement: 'CASH',
        rule: strict,
      }),
    ).toEqual([])
  })

  it('REFUSES a cash amount on a surety-bond lease', () => {
    // The failure this prevents is at move-out: a tenant chased for the
    // return of money nobody ever collected, or an owner believing they hold
    // a deposit they do not.
    const violations = validateDepositAmount({
      depositCents: 150_000,
      rentCents: 150_000,
      arrangement: 'SURETY_BOND',
      rule: texas,
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]!.message).toMatch(/surety bond/i)
  })

  it('is silent about a cap when nothing is held', () => {
    for (const arrangement of ['SURETY_BOND', 'NONE'] as const) {
      expect(
        validateDepositAmount({ depositCents: 0, rentCents: 150_000, arrangement, rule: strict }),
      ).toEqual([])
    }
  })
})

describe('depositHeldCents', () => {
  it('is what was received, not what the lease said to collect', () => {
    // A liability is money actually taken. The two differ for every lease
    // where the tenant paid late, paid partially, or moved out.
    expect(
      depositHeldCents([
        { amountCents: 100_000, kind: 'RECEIVED' },
        { amountCents: 50_000, kind: 'RECEIVED' },
      ]),
    ).toBe(150_000)
  })

  it('falls when money is returned or applied', () => {
    expect(
      depositHeldCents([
        { amountCents: 150_000, kind: 'RECEIVED' },
        { amountCents: 40_000, kind: 'APPLIED' },
        { amountCents: 110_000, kind: 'RETURNED' },
      ]),
    ).toBe(0)
  })

  it('is zero for a lease that never collected one', () => {
    expect(depositHeldCents([])).toBe(0)
  })
})

describe('depositObligations', () => {
  it('names what a strict state demands of money being held', () => {
    const obligations = depositObligations(strict, 'CASH')
    expect(obligations).toHaveLength(2)
    expect(obligations.join(' ')).toMatch(/separate account/i)
    expect(obligations.join(' ')).toMatch(/interest/i)
  })

  it('demands nothing where the state demands nothing', () => {
    expect(depositObligations(texas, 'CASH')).toEqual([])
  })

  it('demands nothing when no cash is held, however strict the state', () => {
    // A surety bond has its own consumer-protection rules; none of them are
    // about money this landlord is sitting on, because there is none.
    expect(depositObligations(strict, 'SURETY_BOND')).toEqual([])
    expect(depositObligations(strict, 'NONE')).toEqual([])
  })
})
