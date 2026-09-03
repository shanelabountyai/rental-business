import { describe, expect, it } from 'vitest'
import { costTotals, validateEvictionCost } from './costs.ts'
import {
  acceptanceWarning,
  cureClock,
  paymentsSinceService,
  readyToFile,
  type CurePayment,
  type ServiceEvent,
} from './cure.ts'
import { canAdvanceTo } from './stages.ts'

// The cure clock is the legally load-bearing part of R-083: filing early, or
// on service the state does not name, is what gets a case dismissed and
// started over. It gets the coverage that implies.

const good = (servedOn: string): ServiceEvent => ({ servedOn, permittedByJurisdiction: true })
const bad = (servedOn: string): ServiceEvent => ({ servedOn, permittedByJurisdiction: false })
const unknown = (servedOn: string): ServiceEvent => ({ servedOn, permittedByJurisdiction: null })

describe('cureClock', () => {
  it('has no clock running before anything is served', () => {
    const clock = cureClock([], 3, '2026-08-21')
    expect(clock.state).toBe('not_served')
    expect(clock.cureBy).toBeNull()
  })

  it('runs from a good service, expiring after the configured days', () => {
    const clock = cureClock([good('2026-08-10')], 3, '2026-08-12')
    expect(clock.state).toBe('running')
    expect(clock.runsFrom).toBe('2026-08-10')
    expect(clock.cureBy).toBe('2026-08-13')
  })

  it('is still running ON the last day to cure, not expired', () => {
    // The tenant has the whole of the last day. Treating the deadline as
    // already past is acting a day early, which is the mistake this whole
    // module exists to prevent.
    const clock = cureClock([good('2026-08-10')], 3, '2026-08-13')
    expect(clock.state).toBe('running')
  })

  it('expires the day after the cure date', () => {
    const clock = cureClock([good('2026-08-10')], 3, '2026-08-14')
    expect(clock.state).toBe('expired')
  })

  it('DEFECTIVE SERVICE runs no clock at all', () => {
    const clock = cureClock([bad('2026-08-10')], 3, '2026-08-30')
    expect(clock.state).toBe('defective_service')
    expect(clock.runsFrom).toBeNull()
    expect(clock.cureBy).toBeNull()
  })

  it('restarts from the later GOOD service when an earlier one was defective', () => {
    // "Defective service restarts everything" - the bad Monday service buys
    // the owner nothing, and the clock starts on Wednesday.
    const clock = cureClock([bad('2026-08-10'), good('2026-08-12')], 3, '2026-08-13')
    expect(clock.state).toBe('running')
    expect(clock.runsFrom).toBe('2026-08-12')
    expect(clock.cureBy).toBe('2026-08-15')
  })

  it('runs from the EARLIEST good service, so re-serving cannot restart a valid clock', () => {
    const clock = cureClock([good('2026-08-10'), good('2026-08-12')], 3, '2026-08-14')
    expect(clock.runsFrom).toBe('2026-08-10')
    expect(clock.state).toBe('expired')
  })

  it('treats an UNCONFIGURED jurisdiction verdict as good service (D-48), never as defective', () => {
    const clock = cureClock([unknown('2026-08-10')], 3, '2026-08-12')
    expect(clock.state).toBe('running')
    expect(clock.runsFrom).toBe('2026-08-10')
  })

  it('never invents a deadline when the cure period is unconfigured', () => {
    const clock = cureClock([good('2026-08-10')], null, '2026-12-31')
    expect(clock.state).toBe('running')
    expect(clock.cureBy).toBeNull()
    expect(clock.periodUnknown).toBe(true)
  })
})

describe('readyToFile', () => {
  const today = '2026-08-21'

  it('refuses with no notice attached', () => {
    expect(readyToFile(cureClock([], 3, today), false).refusal).toBe('no_case_notice')
  })

  it('refuses before the notice is served', () => {
    expect(readyToFile(cureClock([], 3, today), true).refusal).toBe('not_served')
  })

  it('REFUSES ON DEFECTIVE SERVICE, however long ago', () => {
    const clock = cureClock([bad('2020-01-01')], 3, today)
    expect(readyToFile(clock, true).refusal).toBe('defective_service')
  })

  it('refuses while the tenant still has time to cure', () => {
    const clock = cureClock([good('2026-08-20')], 3, today)
    expect(readyToFile(clock, true).refusal).toBe('still_curing')
  })

  it('allows filing once the cure period has expired', () => {
    const clock = cureClock([good('2026-08-01')], 3, today)
    expect(readyToFile(clock, true).ready).toBe(true)
  })

  it('does NOT block filing merely because this product lacks the cure period', () => {
    // Substituting our own ignorance for the owner's attorney would be the
    // wrong call - the packet says the period is unconfigured instead.
    const clock = cureClock([good('2026-08-20')], null, today)
    expect(readyToFile(clock, true).ready).toBe(true)
  })
})

describe('canAdvanceTo', () => {
  it('moves forward one rung at a time', () => {
    expect(canAdvanceTo('NOTICE', 'FILING').allowed).toBe(true)
    expect(canAdvanceTo('JUDGMENT', 'WRIT').allowed).toBe(true)
  })

  it('refuses to skip a rung', () => {
    expect(canAdvanceTo('FILING', 'WRIT').refusal).toBe('skips_a_stage')
  })

  it('refuses to move backwards', () => {
    expect(canAdvanceTo('JUDGMENT', 'FILING').refusal).toBe('not_backwards')
    expect(canAdvanceTo('COURT', 'COURT').refusal).toBe('not_backwards')
  })

  it('closes from anywhere, because settling is always available', () => {
    expect(canAdvanceTo('NOTICE', 'CLOSED').allowed).toBe(true)
    expect(canAdvanceTo('WRIT', 'CLOSED').allowed).toBe(true)
  })

  it('refuses everything once closed', () => {
    expect(canAdvanceTo('CLOSED', 'FILING').refusal).toBe('already_closed')
    expect(canAdvanceTo('CLOSED', 'CLOSED').refusal).toBe('already_closed')
  })
})

describe('eviction costs', () => {
  it('totals by type and overall', () => {
    const totals = costTotals([
      { type: 'FILING', amountCents: 12_100 },
      { type: 'ATTORNEY', amountCents: 50_000 },
      { type: 'FILING', amountCents: 900 },
    ])
    expect(totals.byType).toEqual({ FILING: 13_000, ATTORNEY: 50_000 })
    expect(totals.totalCents).toBe(63_000)
  })

  it('refuses a zero-amount line', () => {
    const violations = validateEvictionCost({
      type: 'FILING',
      amountCents: 0,
      incurredOn: '2026-08-01',
      description: 'Filing fee',
    })
    expect(violations.map((v) => v.field)).toContain('amountDollars')
  })

  it('refuses an unknown cost type and an empty description', () => {
    const violations = validateEvictionCost({
      type: 'BRIBE',
      amountCents: 100,
      incurredOn: '2026-08-01',
      description: '   ',
    })
    expect(violations.map((v) => v.field).sort()).toEqual(['description', 'type'])
  })
})

// R-156. A payment accepted after service is the fact the case page, the
// packet and (per the state's rule) the notice's validity all turn on.
const paid = (receivedOn: string, amountCents = 50_000): CurePayment => ({
  receivedOn,
  amountCents,
  channelLabel: 'ACH',
})

describe('paymentsSinceService', () => {
  it('returns nothing when no service has been recorded', () => {
    expect(paymentsSinceService([], [paid('2026-08-15')])).toEqual([])
  })

  it('keeps payments on or after the first service and drops earlier ones', () => {
    const kept = paymentsSinceService(
      [good('2026-08-10')],
      [paid('2026-08-09'), paid('2026-08-10'), paid('2026-08-14')],
    )
    expect(kept.map((p) => p.receivedOn)).toEqual(['2026-08-10', '2026-08-14'])
  })

  it('anchors at the earliest service even when that service was defective', () => {
    // A defectively-served notice was still put in the tenant's hands, so a
    // payment accepted after it must surface - hiding it would be the
    // product deciding the legal question in the risky direction.
    const kept = paymentsSinceService(
      [bad('2026-08-10'), good('2026-08-14')],
      [paid('2026-08-11')],
    )
    expect(kept).toHaveLength(1)
  })

  it('sorts what it keeps by date', () => {
    const kept = paymentsSinceService(
      [good('2026-08-01')],
      [paid('2026-08-20'), paid('2026-08-05')],
    )
    expect(kept.map((p) => p.receivedOn)).toEqual(['2026-08-05', '2026-08-20'])
  })
})

describe('acceptanceWarning', () => {
  it('warns that acceptance may waive when the state is unreviewed', () => {
    // null is D-48's "nobody has told us" - the warning must not answer for
    // the state in either direction, and the cheap direction to be wrong in
    // is the cautious one.
    expect(acceptanceWarning(null)).toContain('has not been taught')
  })

  it('states the configured rule when counsel has answered', () => {
    expect(acceptanceWarning(true)).toContain('waives the notice')
    expect(acceptanceWarning(false)).toContain('does not by itself waive')
  })
})
