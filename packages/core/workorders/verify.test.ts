import { describe, expect, it } from 'vitest'
import {
  closeDecision,
  jobCostCents,
  validateVerification,
  vendorReopenRates,
} from './index.ts'

describe('validateVerification', () => {
  it('accepts a bare yes - one tap is the whole requirement', () => {
    expect(validateVerification({ resolved: true })).toEqual([])
  })

  it('accepts a no with no words, because that is still an answer', () => {
    expect(validateVerification({ resolved: false })).toEqual([])
  })

  it('demands an actual answer', () => {
    expect(validateVerification({ resolved: undefined }).map((v) => v.field)).toEqual([
      'resolved',
    ])
  })

  it('never demands a rating', () => {
    // The rating is management information; the answer is what the close
    // depends on. Requiring it would put a second decision between a tenant
    // and the word "yes".
    expect(validateVerification({ resolved: true, rating: null })).toEqual([])
  })

  it('refuses a rating outside 1-5, and a fractional one', () => {
    expect(validateVerification({ resolved: true, rating: 0 })).toHaveLength(1)
    expect(validateVerification({ resolved: true, rating: 6 })).toHaveLength(1)
    expect(validateVerification({ resolved: true, rating: 4.5 })).toHaveLength(1)
    expect(validateVerification({ resolved: true, rating: 5 })).toEqual([])
  })
})

describe('closeDecision', () => {
  const complete = {
    status: 'WORK_COMPLETE',
    tenantId: 'tenant_1',
    verifiedResolved: true,
    actualLaborCents: 12_000,
    actualMaterialsCents: 3_400,
    invoiceCents: null,
  }

  it('closes a verified job with costs recorded', () => {
    expect(closeDecision(complete)).toEqual({ allowed: true, unverified: false })
  })

  it('REFUSES to close over a tenant saying it is not fixed', () => {
    // The single worst outcome this item can produce: a live complaint
    // recorded as resolved is what a tenant later shows a judge.
    const decision = closeDecision({ ...complete, verifiedResolved: false })
    expect(decision).toEqual({ allowed: false, refusal: 'tenant_says_unresolved' })
  })

  it('refuses a "not fixed" BEFORE any bookkeeping complaint', () => {
    // Ordering is the point: a missing invoice is a data-entry problem, an
    // unresolved complaint is a legal one, and the message must name the
    // second.
    const decision = closeDecision({
      ...complete,
      verifiedResolved: false,
      actualLaborCents: null,
      actualMaterialsCents: null,
    })
    expect(decision.refusal).toBe('tenant_says_unresolved')
  })

  it('refuses to close work that is not finished', () => {
    expect(closeDecision({ ...complete, status: 'IN_PROGRESS' }).refusal).toBe(
      'not_complete',
    )
  })

  it('closes an unanswered job, and SAYS it is unverified', () => {
    // A tenant who never replies must not hold a work order open forever -
    // but the PM signs for that, and the record says so afterwards.
    expect(closeDecision({ ...complete, verifiedResolved: null })).toEqual({
      allowed: true,
      unverified: true,
    })
  })

  it('closes a job with no tenant to ask', () => {
    const decision = closeDecision({
      ...complete,
      tenantId: null,
      verifiedResolved: null,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.unverified).toBe(true)
  })

  it('refuses a $0 close unless somebody says it was free', () => {
    const free = {
      ...complete,
      actualLaborCents: null,
      actualMaterialsCents: null,
      invoiceCents: null,
    }
    expect(closeDecision(free).refusal).toBe('no_cost_recorded')
    expect(closeDecision(free, true).allowed).toBe(true)
  })

  it('treats an explicit zero invoice as a recorded cost only when acknowledged', () => {
    // A warranty callback really can be $0. What must not happen is a job
    // drifting closed at nothing because nobody filled the form in.
    const zero = {
      ...complete,
      actualLaborCents: 0,
      actualMaterialsCents: 0,
      invoiceCents: 0,
    }
    expect(zero.invoiceCents).toBe(0)
    expect(closeDecision(zero).refusal).toBe('no_cost_recorded')
    expect(closeDecision(zero, true).allowed).toBe(true)
  })

  it('accepts a job already moved to VERIFIED', () => {
    expect(closeDecision({ ...complete, status: 'VERIFIED' }).allowed).toBe(true)
  })
})

describe('jobCostCents', () => {
  it('takes the invoice where there is one', () => {
    // Not the sum. A vendor who itemises their own invoice would otherwise
    // be counted twice on every job.
    expect(
      jobCostCents({
        actualLaborCents: 12_000,
        actualMaterialsCents: 3_400,
        invoiceCents: 15_000,
      }),
    ).toBe(15_000)
  })

  it('falls back to labour plus materials with no invoice', () => {
    expect(
      jobCostCents({
        actualLaborCents: 12_000,
        actualMaterialsCents: 3_400,
        invoiceCents: null,
      }),
    ).toBe(15_400)
  })

  it('honours an invoice of zero rather than falling through to the parts', () => {
    expect(
      jobCostCents({
        actualLaborCents: 12_000,
        actualMaterialsCents: 0,
        invoiceCents: 0,
      }),
    ).toBe(0)
  })

  it('is zero when nothing is recorded', () => {
    expect(
      jobCostCents({
        actualLaborCents: null,
        actualMaterialsCents: null,
        invoiceCents: null,
      }),
    ).toBe(0)
  })
})

describe('vendorReopenRates', () => {
  const rows = [
    { vendorId: 'good', resolved: true, rating: 5 },
    { vendorId: 'good', resolved: true, rating: 4 },
    { vendorId: 'good', resolved: true, rating: null },
    { vendorId: 'bad', resolved: false, rating: 1 },
    { vendorId: 'bad', resolved: true, rating: 3 },
    { vendorId: null, resolved: false, rating: 2 },
  ]

  it('computes the rate per vendor and puts the worst first', () => {
    const rates = vendorReopenRates(rows)
    expect(rates.map((r) => r.vendorId)).toEqual(['bad', 'good'])
    expect(rates[0]).toMatchObject({ verified: 2, reopened: 1, reopenRate: 0.5 })
    expect(rates[1]).toMatchObject({ verified: 3, reopened: 0, reopenRate: 0 })
  })

  it('averages only the answers that carried a rating', () => {
    const rates = vendorReopenRates(rows)
    expect(rates.find((r) => r.vendorId === 'good')?.averageRating).toBe(4.5)
  })

  it('is null where nobody rated', () => {
    const rates = vendorReopenRates([{ vendorId: 'v', resolved: true, rating: null }])
    expect(rates[0]?.averageRating).toBeNull()
  })

  it('IGNORES in-house work entirely', () => {
    // A job nobody was dispatched for cannot count against a vendor, and
    // must not become a phantom row in a vendor report.
    expect(vendorReopenRates(rows).map((r) => r.vendorId)).not.toContain(null)
    expect(vendorReopenRates([{ vendorId: null, resolved: false, rating: null }])).toEqual(
      [],
    )
  })

  it('can hide vendors with too few answers to mean anything', () => {
    // A 100% reopen rate off one job is noise, and putting it at the top of
    // a "who should I stop calling" list is worse than leaving it out.
    const rates = vendorReopenRates(rows, 3)
    expect(rates.map((r) => r.vendorId)).toEqual(['good'])
  })

  it('counts only ANSWERED jobs, so a silent tenant cannot mark a vendor down', () => {
    // The denominator is answers, not dispatches - a verification row only
    // exists once somebody replied.
    const rates = vendorReopenRates([{ vendorId: 'v', resolved: false, rating: null }])
    expect(rates[0]).toMatchObject({ verified: 1, reopened: 1, reopenRate: 1 })
  })

  it('is stable when two vendors tie', () => {
    const tied = [
      { vendorId: 'b', resolved: true, rating: null },
      { vendorId: 'a', resolved: true, rating: null },
    ]
    expect(vendorReopenRates(tied).map((r) => r.vendorId)).toEqual(['a', 'b'])
    expect(vendorReopenRates([...tied].reverse()).map((r) => r.vendorId)).toEqual(['a', 'b'])
  })
})
