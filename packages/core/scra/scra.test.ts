import { describe, expect, it } from 'vitest'
import {
  affidavitReadiness,
  LOOKUP_STALE_AFTER_DAYS,
  SCRA_LOOKUP_RESULTS,
  SCRA_TERMINATION_BASES,
  SCRA_BASIS_EVIDENCE,
  SCRA_BASIS_LABELS,
  scraTermination,
} from './index.ts'

// The worked examples below drive `scraTermination` - the function the
// product calls - and assert on `.effectiveOn`. They were written against a
// duplicate (`scraTerminationDate`) that R-149 deleted; the statute they
// document is unchanged.
const terminationDate = (deliveredOn: string, rentDueDay: number) =>
  scraTermination({
    deliveredOn,
    rentDueDay,
    basis: 'pcs_or_deployment',
    hasOrdersOnFile: true,
  }).effectiveOn

describe('§3955 termination date', () => {
  // THE WORKED EXAMPLE EVERY SCRA GUIDE LEADS WITH, and the reason "after"
  // is not "on or after": notice delivered ON the rent due date does not
  // count that date's payment as the next one.
  it('notice on 1 August against rent due on the 1st ends the tenancy on 1 October', () => {
    expect(terminationDate('2026-08-01', 1)).toBe('2026-10-01')
  })

  it('notice the day after the due date lands the same way', () => {
    // 2 August: next payment due after that is 1 September, +30 = 1 October.
    expect(terminationDate('2026-08-02', 1)).toBe('2026-10-01')
  })

  it('notice just before the due date runs from that month', () => {
    // 31 July: the next payment due after it is 1 August, +30 = 31 August.
    expect(terminationDate('2026-07-31', 1)).toBe('2026-08-31')
  })

  it('handles a mid-month rent day', () => {
    // Delivered 20 June, rent due the 15th: next due after 20 June is
    // 15 July, +30 = 14 August.
    expect(terminationDate('2026-06-20', 15)).toBe('2026-08-14')
  })

  it('clamps a 31st rent day in a short month', () => {
    // Delivered 15 January, rent due the 31st: next due after is 31 January,
    // +30 = 2 March (2026 is not a leap year).
    expect(terminationDate('2026-01-15', 31)).toBe('2026-03-02')
    // Delivered 1 February, rent due the 31st: February's due day clamps to
    // the 28th, +30 = 30 March.
    expect(terminationDate('2026-02-01', 31)).toBe('2026-03-30')
  })

  it('crosses a year boundary', () => {
    expect(terminationDate('2026-12-05', 1)).toBe('2027-01-31')
  })
})

describe('scraTermination', () => {
  it('refuses without the orders, and still says what the date would be', () => {
    const result = scraTermination({
      deliveredOn: '2026-08-01',
      rentDueDay: 1,
      basis: 'pcs_or_deployment',
      hasOrdersOnFile: false,
    })
    expect(result.refusal).toBe('no_orders')
    // The PM is on the phone with the tenant. They still need the date.
    expect(result.effectiveOn).toBe('2026-10-01')
    expect(result.runsFromRentDue).toBe('2026-09-01')
  })

  it('carries no refusal once the orders are on file', () => {
    const result = scraTermination({
      deliveredOn: '2026-08-01',
      rentDueDay: 1,
      basis: 'entered_service',
      hasOrdersOnFile: true,
    })
    expect(result.refusal).toBeUndefined()
    expect(result.effectiveOn).toBe('2026-10-01')
  })

  it('describes the evidence each basis needs', () => {
    for (const basis of SCRA_TERMINATION_BASES) {
      expect(SCRA_BASIS_LABELS[basis]).toBeTruthy()
      expect(SCRA_BASIS_EVIDENCE[basis]).toBeTruthy()
    }
  })
})

describe('§3931 affidavit readiness', () => {
  const today = '2026-09-01'

  it('does not apply at all when the tenant appeared', () => {
    // A contested hearing needs no affidavit. Demanding one would be the
    // product inventing a requirement.
    expect(affidavitReadiness({ tenantAppeared: true, lookup: null, today }).ready).toBe(true)
  })

  it('REFUSES a default judgment with no search on file', () => {
    const decision = affidavitReadiness({ tenantAppeared: false, lookup: null, today })
    expect(decision.ready).toBe(false)
    expect(decision.refusal).toBe('no_lookup')
  })

  it('treats an unanswered "did they appear" as not established, not as appeared', () => {
    const decision = affidavitReadiness({ tenantAppeared: null, lookup: null, today })
    expect(decision.ready).toBe(false)
    expect(decision.refusal).toBe('no_lookup')
  })

  it('REFUSES when the search says the tenant is serving', () => {
    const decision = affidavitReadiness({
      tenantAppeared: false,
      lookup: { result: 'in_service', searchedOn: '2026-08-30' },
      today,
    })
    expect(decision.ready).toBe(false)
    expect(decision.refusal).toBe('in_service')
  })

  it('REFUSES on a no-match — which is not the same as "not serving"', () => {
    // The distinction this whole enum exists for: collapsing indeterminate
    // into not_in_service is how a false affidavit gets signed.
    const decision = affidavitReadiness({
      tenantAppeared: false,
      lookup: { result: 'indeterminate', searchedOn: '2026-08-30' },
      today,
    })
    expect(decision.ready).toBe(false)
    expect(decision.refusal).toBe('indeterminate')
  })

  it('allows a fresh negative search', () => {
    const decision = affidavitReadiness({
      tenantAppeared: false,
      lookup: { result: 'not_in_service', searchedOn: '2026-08-30' },
      today,
    })
    expect(decision.ready).toBe(true)
    expect(decision.stale).toBeUndefined()
  })

  it('WARNS but does not refuse on a stale one', () => {
    const decision = affidavitReadiness({
      tenantAppeared: false,
      lookup: { result: 'not_in_service', searchedOn: '2026-06-01' },
      today,
    })
    expect(decision.ready).toBe(true)
    expect(decision.stale).toBe(true)
    expect(decision.staleDays).toBe(92)
  })

  it('is not stale on the boundary day itself', () => {
    const searchedOn = '2026-08-02' // exactly 30 days before today
    const decision = affidavitReadiness({
      tenantAppeared: false,
      lookup: { result: 'not_in_service', searchedOn },
      today,
    })
    expect(LOOKUP_STALE_AFTER_DAYS).toBe(30)
    expect(decision.stale).toBeUndefined()
  })

  it('has a label for every result', () => {
    expect(SCRA_LOOKUP_RESULTS).toHaveLength(3)
  })
})
