import { describe, expect, it } from 'vitest'
import { costTotals, validateEvictionCost } from './costs.ts'
import { packetBlocks, type PacketFacts } from './packet.ts'
import {
  acceptanceWarning,
  cureClock,
  paymentsSinceService,
  readyToFile,
  type CurePayment,
  type ServiceEvent,
} from './cure.ts'
import {
  cureDemand,
  cureNoticeText,
  cureVerdict,
  cureVerdictSentence,
  demandKind,
  feeDemandWarning,
  partialCureWarning,
  type DemandDebt,
} from './demand.ts'
import { canAdvanceTo } from './stages.ts'
import { UNREVIEWED_DAY_COUNT } from '../scheduling/deadline.ts'

// R-182: the cure clock now takes how the state COUNTS its days as well as
// how many there are. These cases are all Texas, which counts calendar days,
// and `TX_CALENDAR` is that stated explicitly rather than inherited from a
// default - the point of the item is that a default is the defect.
const TX_CALENDAR = { dayCountBasis: 'CALENDAR' as const, observedHolidays: [] }

// The cure clock is the legally load-bearing part of R-083: filing early, or
// on service the state does not name, is what gets a case dismissed and
// started over. It gets the coverage that implies.

const good = (servedOn: string): ServiceEvent => ({ servedOn, permittedByJurisdiction: true })
const bad = (servedOn: string): ServiceEvent => ({ servedOn, permittedByJurisdiction: false })
const unknown = (servedOn: string): ServiceEvent => ({ servedOn, permittedByJurisdiction: null })

describe('cureClock', () => {
  it('has no clock running before anything is served', () => {
    const clock = cureClock([], 3, '2026-08-21', TX_CALENDAR)
    expect(clock.state).toBe('not_served')
    expect(clock.cureBy).toBeNull()
  })

  it('runs from a good service, expiring after the configured days', () => {
    const clock = cureClock([good('2026-08-10')], 3, '2026-08-12', TX_CALENDAR)
    expect(clock.state).toBe('running')
    expect(clock.runsFrom).toBe('2026-08-10')
    expect(clock.cureBy).toBe('2026-08-13')
  })

  it('is still running ON the last day to cure, not expired', () => {
    // The tenant has the whole of the last day. Treating the deadline as
    // already past is acting a day early, which is the mistake this whole
    // module exists to prevent.
    const clock = cureClock([good('2026-08-10')], 3, '2026-08-13', TX_CALENDAR)
    expect(clock.state).toBe('running')
  })

  it('expires the day after the cure date', () => {
    const clock = cureClock([good('2026-08-10')], 3, '2026-08-14', TX_CALENDAR)
    expect(clock.state).toBe('expired')
  })

  it('DEFECTIVE SERVICE runs no clock at all', () => {
    const clock = cureClock([bad('2026-08-10')], 3, '2026-08-30', TX_CALENDAR)
    expect(clock.state).toBe('defective_service')
    expect(clock.runsFrom).toBeNull()
    expect(clock.cureBy).toBeNull()
  })

  it('restarts from the later GOOD service when an earlier one was defective', () => {
    // "Defective service restarts everything" - the bad Monday service buys
    // the owner nothing, and the clock starts on Wednesday.
    const clock = cureClock([bad('2026-08-10'), good('2026-08-12')], 3, '2026-08-13', TX_CALENDAR)
    expect(clock.state).toBe('running')
    expect(clock.runsFrom).toBe('2026-08-12')
    expect(clock.cureBy).toBe('2026-08-15')
  })

  it('runs from the EARLIEST good service, so re-serving cannot restart a valid clock', () => {
    const clock = cureClock([good('2026-08-10'), good('2026-08-12')], 3, '2026-08-14', TX_CALENDAR)
    expect(clock.runsFrom).toBe('2026-08-10')
    expect(clock.state).toBe('expired')
  })

  it('treats an UNCONFIGURED jurisdiction verdict as good service (D-48), never as defective', () => {
    const clock = cureClock([unknown('2026-08-10')], 3, '2026-08-12', TX_CALENDAR)
    expect(clock.state).toBe('running')
    expect(clock.runsFrom).toBe('2026-08-10')
  })

  it('never invents a deadline when the cure period is unconfigured', () => {
    const clock = cureClock([good('2026-08-10')], null, '2026-12-31', TX_CALENDAR)
    expect(clock.state).toBe('running')
    expect(clock.cureBy).toBeNull()
    expect(clock.periodUnknown).toBe(true)
  })
})

describe('readyToFile', () => {
  const today = '2026-08-21'

  it('refuses with no notice attached', () => {
    expect(readyToFile(cureClock([], 3, today, TX_CALENDAR), false).refusal).toBe('no_case_notice')
  })

  it('refuses before the notice is served', () => {
    expect(readyToFile(cureClock([], 3, today, TX_CALENDAR), true).refusal).toBe('not_served')
  })

  it('REFUSES ON DEFECTIVE SERVICE, however long ago', () => {
    const clock = cureClock([bad('2020-01-01')], 3, today, TX_CALENDAR)
    expect(readyToFile(clock, true).refusal).toBe('defective_service')
  })

  it('refuses while the tenant still has time to cure', () => {
    const clock = cureClock([good('2026-08-20')], 3, today, TX_CALENDAR)
    expect(readyToFile(clock, true).refusal).toBe('still_curing')
  })

  it('allows filing once the cure period has expired', () => {
    const clock = cureClock([good('2026-08-01')], 3, today, TX_CALENDAR)
    expect(readyToFile(clock, true).ready).toBe(true)
  })

  it('does NOT block filing merely because this product lacks the cure period', () => {
    // Substituting our own ignorance for the owner's attorney would be the
    // wrong call - the packet says the period is unconfigured instead.
    const clock = cureClock([good('2026-08-20')], null, today, TX_CALENDAR)
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

// R-194. The demand is the figure a filing decision is read against, and it
// is stored on an append-only row, so a wrong number here is permanent.
describe('cureDemand', () => {
  const rent = (dueOn: string, amountCents = 150_000): DemandDebt => ({ dueOn, amountCents, label: 'Rent', kind: 'RENT' })
  const fee = (dueOn: string, amountCents = 7_500): DemandDebt => ({ dueOn, amountCents, label: 'Late fee', kind: 'FEE' })

  it('demands nothing on a settled or credit balance', () => {
    expect(cureDemand({ balanceCents: 0, debts: [rent('2026-09-01')], mayIncludeFees: true })).toEqual({
      demandedCents: 0,
      lines: [],
    })
  })

  it('demands only the debts the balance still sits on, newest first, listed oldest first', () => {
    // $1,575 owed against August rent, September rent and a September fee:
    // payments settle oldest-first, so August is paid and must not be demanded.
    const demand = cureDemand({
      balanceCents: 157_500,
      debts: [rent('2026-08-01'), rent('2026-09-01'), fee('2026-09-06')],
      mayIncludeFees: true,
    })
    expect(demand.demandedCents).toBe(157_500)
    expect(demand.lines.map((l) => [l.dueOn, l.amountCents])).toEqual([
      ['2026-09-01', 150_000],
      ['2026-09-06', 7_500],
    ])
  })

  it('keeps fees out of the total, but on the record, when the rule says rent only', () => {
    const demand = cureDemand({
      balanceCents: 157_500,
      debts: [rent('2026-09-01'), fee('2026-09-06')],
      mayIncludeFees: false,
    })
    expect(demand.demandedCents).toBe(150_000)
    expect(demand.lines.find((l) => l.kind === 'FEE')).toMatchObject({ amountCents: 7_500, demanded: false })
  })

  it('includes fees when nobody has reviewed the state, and the warning says so', () => {
    const demand = cureDemand({
      balanceCents: 157_500,
      debts: [rent('2026-09-01'), fee('2026-09-06')],
      mayIncludeFees: null,
    })
    expect(demand.demandedCents).toBe(157_500)
    expect(feeDemandWarning(null)).toContain('has not been taught')
    expect(feeDemandWarning(false)).toContain('rent only')
    expect(feeDemandWarning(true)).toBeNull()
  })

  it('demands balance no dated debt explains as earlier rent, never drops it', () => {
    const demand = cureDemand({ balanceCents: 400_000, debts: [rent('2026-09-01')], mayIncludeFees: false })
    expect(demand.demandedCents).toBe(400_000)
    expect(demand.lines[0]).toMatchObject({ label: 'Rent from earlier periods', dueOn: null, amountCents: 250_000 })
  })

  it('treats pet rent as rent and every other charge type as a fee', () => {
    expect(demandKind('RENT')).toBe('RENT')
    expect(demandKind('PET_RENT')).toBe('RENT')
    expect(demandKind('LATE_FEE')).toBe('FEE')
    expect(demandKind('UTILITY')).toBe('FEE')
  })

  it('writes only the demanded lines and the total into the notice text', () => {
    const demand = cureDemand({
      balanceCents: 157_500,
      debts: [rent('2026-09-01'), fee('2026-09-06')],
      mayIncludeFees: false,
    })
    const text = cureNoticeText({
      title: 'Notice to vacate',
      tenantNames: ['Ada Tenant'],
      addressLine1: '4 Courthouse Way',
      unitName: null,
      demand,
      payOrQuitDays: 3,
    })
    expect(text).toContain('Rent, due 1 Sept 2026: $1,500.00')
    expect(text).toContain('Total demanded: $1,500.00')
    expect(text).not.toContain('Late fee')
    expect(text).toContain('within 3 days')
    expect(text).toContain('not legal advice')
  })
})

describe('cureVerdict', () => {
  it('counts kept payments from drafting through the last day to cure, both ends inclusive', () => {
    const verdict = cureVerdict(
      150_000,
      [paid('2026-08-31', 99_999), paid('2026-09-01', 50_000), paid('2026-09-04', 25_000), paid('2026-09-05', 75_000)],
      '2026-09-01',
      '2026-09-04',
    )
    expect(verdict).toMatchObject({ state: 'part_cured', keptCents: 75_000 })
  })

  it('is cured when what was kept inside the window meets the demand', () => {
    expect(cureVerdict(150_000, [paid('2026-09-02', 150_000)], '2026-09-01', '2026-09-04').state).toBe('cured')
  })

  it('is not cured when nothing was kept inside the window', () => {
    expect(cureVerdict(150_000, [paid('2026-09-10', 150_000)], '2026-09-01', '2026-09-04').state).toBe('not_cured')
  })

  it('counts every payment since drafting when no cure period is configured, and says so', () => {
    const verdict = cureVerdict(150_000, [paid('2026-12-01', 150_000)], '2026-09-01', null)
    expect(verdict.state).toBe('cured')
    expect(cureVerdictSentence(verdict, 'running')).toContain('no cure period is configured')
  })

  it('says it cannot answer for a notice from before demands were recorded', () => {
    const verdict = cureVerdict(null, [paid('2026-09-02', 150_000)], '2026-09-01', '2026-09-04')
    expect(verdict.state).toBe('demand_not_recorded')
    expect(cureVerdictSentence(verdict, 'expired')).toContain('cannot be worked out')
  })

  it('says "so far" until the cure period has run out', () => {
    const verdict = cureVerdict(150_000, [paid('2026-09-02', 40_000)], '2026-09-01', '2026-09-04')
    expect(cureVerdictSentence(verdict, 'running')).toBe(
      'Part-cured so far: $400.00 of $1,500.00 kept between drafting and the last day to cure, $1,100.00 short.',
    )
    expect(cureVerdictSentence(verdict, 'expired')).toMatch(/^Part-cured: /)
  })

  it('states the partial-payment rule without answering for an unreviewed state', () => {
    expect(partialCureWarning(null)).toContain('has not been taught')
    expect(partialCureWarning(true)).toContain('cures the notice')
    expect(partialCureWarning(false)).toContain('only payment in full cures')
  })
})

describe('packetBlocks', () => {
  // R-204's demo walk (D-28). Every other date on this packet is formatted by
  // its caller - `asDate` in apps/web/lib/evictions/packet.ts wraps all seven
  // of them - but `clock` is passed through as a typed `CureClock`, not as
  // caller-formatted strings, so its two `BusinessDate`s reached the PDF raw:
  // "Last day to cure: 2026-09-09" on the document an attorney files from.
  // Both screens that show the same two values already call
  // `friendlyBusinessDate`, which is why no test caught it and no screen
  // showed it.
  const facts = {
    propertyName: 'Riverside Court Duplex',
    addressLine1: '48 Riverside Ct',
    unitName: 'Unit A',
    tenantNames: ['Maria Alvarez'],
    stage: 'NOTICE',
    outcome: null,
    openedOn: '2 Sept 2026',
    closedOn: null,
    filedOn: null,
    courtDate: null,
    judgmentOn: null,
    writOn: null,
    lockoutOn: null,
    clock: {
      state: 'running',
      runsFrom: '2026-09-02',
      cureBy: '2026-09-09',
      periodUnknown: false,
    },
    paymentsSinceService: [],
    acceptanceWarning: '',
    cureVerdict: null,
    costs: { byType: {}, totalCents: 0 },
    ledgerBalanceCents: null,
    exhibits: [],
    generatedAt: '12 Sept 2026, 09:14 CDT',
    generatedBy: 'Dana Reyes',
    timezone: 'America/Chicago',
  } as const satisfies PacketFacts

  it('prints the two dates a filing turns on as English, not as YYYY-MM-DD', () => {
    const text = packetBlocks(facts).map((block) => block.text).join('\n')

    expect(text).toContain('Cure period runs from: 2 Sept 2026')
    expect(text).toContain('Last day to cure: 9 Sept 2026')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
