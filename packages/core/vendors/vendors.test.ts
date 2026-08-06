import { describe, expect, it } from 'vitest'
import {
  type VendorCandidate,
  fallbackVendorsForTrade,
  isVendorResponse,
  noResponseHoursFor,
  validateVendorInvoice,
  validateVendorResponse,
  vendorHasNotResponded,
  vendorLinkAccess,
  vendorMayRespond,
  vendorMayUpload,
} from './index.ts'

describe('vendorLinkAccess', () => {
  const base = {
    tokenWorkOrderId: 'wo_1',
    workOrderId: 'wo_1',
    tokenVendorId: 'v_1',
    currentVendorId: 'v_1',
    status: 'ASSIGNED',
  }

  it('allows the vendor the link was issued to, on the work order it names', () => {
    expect(vendorLinkAccess(base)).toEqual({ ok: true })
  })

  it('REFUSES a token minted for a different work order', () => {
    expect(vendorLinkAccess({ ...base, workOrderId: 'wo_2' })).toEqual({
      ok: false,
      reason: 'wrong_work_order',
    })
  })

  it('REFUSES the old vendor once the work order is reassigned', () => {
    // The whole reason this check exists: the fired vendor's token has not
    // expired and cannot be un-sent, so only this comparison stops them
    // opening a live gate code.
    expect(vendorLinkAccess({ ...base, currentVendorId: 'v_2' })).toEqual({
      ok: false,
      reason: 'reassigned',
    })
  })

  it('REFUSES once the work order is unassigned entirely', () => {
    expect(vendorLinkAccess({ ...base, currentVendorId: null })).toEqual({
      ok: false,
      reason: 'reassigned',
    })
  })

  it('REFUSES on a closed or canceled work order - the link must not outlive the job', () => {
    for (const status of ['CLOSED', 'CANCELED', 'VERIFIED', 'INVOICED']) {
      expect(vendorLinkAccess({ ...base, status }), status).toEqual({
        ok: false,
        reason: 'not_actionable',
      })
    }
  })

  it('stays live across every status where the vendor still has something to do', () => {
    for (const status of [
      'ASSIGNED',
      'SCHEDULED',
      'IN_PROGRESS',
      'WORK_COMPLETE',
      'ON_HOLD_WARRANTY',
      'WAITING_ON_TENANT',
    ]) {
      expect(vendorLinkAccess({ ...base, status }), status).toEqual({ ok: true })
    }
  })
})

describe('vendorMayRespond / vendorMayUpload', () => {
  it('lets an unanswered link answer, once', () => {
    expect(vendorMayRespond(null)).toBe(true)
    for (const response of ['ACCEPTED', 'DECLINED', 'PROPOSED_TIME']) {
      expect(vendorMayRespond(response), response).toBe(false)
    }
  })

  it('lets an accepted vendor keep uploading, and a declined one upload nothing', () => {
    // Wider than respond on purpose - the invoice usually lands after the
    // work is already marked done.
    expect(vendorMayUpload('ACCEPTED')).toBe(true)
    expect(vendorMayUpload('PROPOSED_TIME')).toBe(true)
    expect(vendorMayUpload('DECLINED')).toBe(false)
    expect(vendorMayUpload(null)).toBe(false)
  })
})

describe('the no-response timer', () => {
  const dispatchedAt = new Date('2026-08-05T12:00:00Z')

  it('gives an emergency a much shorter fuse than a routine job', () => {
    expect(noResponseHoursFor('EMERGENCY')).toBeLessThan(noResponseHoursFor('URGENT'))
    expect(noResponseHoursFor('URGENT')).toBeLessThan(noResponseHoursFor('ROUTINE'))
  })

  it('falls back to the routine threshold for an unrecognised priority', () => {
    expect(noResponseHoursFor('WHENEVER')).toBe(noResponseHoursFor('ROUTINE'))
  })

  it('reports silence once the threshold has elapsed', () => {
    const state = { priority: 'URGENT', dispatchedAt, vendorRespondedAt: null }
    expect(vendorHasNotResponded(state, new Date('2026-08-05T19:00:00Z'))).toBe(false)
    expect(vendorHasNotResponded(state, new Date('2026-08-05T20:00:00Z'))).toBe(true)
  })

  it('never reports a work order that was never dispatched', () => {
    // A work order nobody sent anywhere is a PM's own to-do, not a silent
    // vendor - reporting it here would bury the real ones.
    expect(
      vendorHasNotResponded(
        { priority: 'EMERGENCY', dispatchedAt: null, vendorRespondedAt: null },
        new Date('2030-01-01'),
      ),
    ).toBe(false)
  })

  it('never reports one the vendor already answered', () => {
    expect(
      vendorHasNotResponded(
        { priority: 'EMERGENCY', dispatchedAt, vendorRespondedAt: new Date('2026-08-05T12:05:00Z') },
        new Date('2030-01-01'),
      ),
    ).toBe(false)
  })
})

describe('fallbackVendorsForTrade', () => {
  const now = new Date('2026-08-05')
  const vendors: VendorCandidate[] = [
    { id: 'v1', name: 'Zeta Plumbing', trades: ['plumbing'], preferredRank: 1, active: true, w9OnFile: true, coiExpiresOn: null },
    { id: 'v2', name: 'Alpha Plumbing', trades: ['plumbing'], preferredRank: null, active: true, w9OnFile: false, coiExpiresOn: new Date('2020-01-01') },
    { id: 'v3', name: 'Beta Plumbing', trades: ['plumbing'], preferredRank: null, active: true, w9OnFile: true, coiExpiresOn: null },
    { id: 'v4', name: 'Gone Plumbing', trades: ['plumbing'], preferredRank: 0, active: false, w9OnFile: true, coiExpiresOn: null },
    { id: 'v5', name: 'Sparky', trades: ['electrical'], preferredRank: 1, active: true, w9OnFile: true, coiExpiresOn: null },
  ]

  it('returns only active vendors who work the trade, preferred first', () => {
    const ranked = fallbackVendorsForTrade(vendors, 'plumbing', now)
    expect(ranked.map((v) => v.id)).toEqual(['v1', 'v2', 'v3'])
  })

  it('sorts unranked vendors after ranked ones, then by name for stability', () => {
    const ranked = fallbackVendorsForTrade(vendors, 'plumbing', now)
    expect(ranked.slice(1).map((v) => v.name)).toEqual(['Alpha Plumbing', 'Beta Plumbing'])
  })

  it('excludes whoever already declined, so "next vendor" means next', () => {
    const ranked = fallbackVendorsForTrade(vendors, 'plumbing', now, ['v1'])
    expect(ranked.map((v) => v.id)).toEqual(['v2', 'v3'])
  })

  it('SURFACES a missing W-9 or expired COI rather than hiding that vendor', () => {
    // MAINT-11 blocks PAYMENT without a W-9; it does not forbid dispatching
    // the only plumber who answers at 2am. Hiding them would leave the PM
    // wondering why the list is short.
    const ranked = fallbackVendorsForTrade(vendors, 'plumbing', now)
    const alpha = ranked.find((v) => v.id === 'v2')!
    expect(alpha.w9Missing).toBe(true)
    expect(alpha.coiExpired).toBe(true)
    expect(ranked.find((v) => v.id === 'v1')!.w9Missing).toBe(false)
  })
})

describe('validateVendorResponse', () => {
  it('accepts a plain accept', () => {
    expect(validateVendorResponse({ response: 'ACCEPTED' })).toEqual([])
  })

  it('rejects an invented response', () => {
    expect(validateVendorResponse({ response: 'MAYBE' }).map((v) => v.field)).toContain('response')
  })

  it('requires a reason on a decline, so the PM knows who to try next', () => {
    expect(validateVendorResponse({ response: 'DECLINED' }).map((v) => v.field)).toContain(
      'declineReason',
    )
    expect(
      validateVendorResponse({ response: 'DECLINED', declineReason: 'Booked until Friday' }),
    ).toEqual([])
  })

  it('requires a valid, ordered window when proposing a time', () => {
    expect(validateVendorResponse({ response: 'PROPOSED_TIME' }).length).toBeGreaterThan(0)
    expect(
      validateVendorResponse({
        response: 'PROPOSED_TIME',
        proposedStart: '2026-08-06T09:00',
        proposedEnd: '2026-08-06T08:00',
      }).map((v) => v.field),
    ).toContain('proposedEnd')
    expect(
      validateVendorResponse({
        response: 'PROPOSED_TIME',
        proposedStart: '2026-08-06T09:00',
        proposedEnd: '2026-08-06T11:00',
      }),
    ).toEqual([])
  })
})

describe('validateVendorInvoice', () => {
  it('accepts a napkin photo with no total on it at all', () => {
    // MAINT-03: "even a napkin photo". The photo is the artifact; the number
    // is a convenience the PM can fill in later.
    expect(validateVendorInvoice({})).toEqual([])
    expect(validateVendorInvoice({ invoiceCents: null })).toEqual([])
  })

  it('rejects a negative or fractional amount', () => {
    expect(validateVendorInvoice({ invoiceCents: -1 }).length).toBe(1)
    expect(validateVendorInvoice({ invoiceCents: 10.5 }).length).toBe(1)
    expect(validateVendorInvoice({ invoiceCents: 12_500 })).toEqual([])
  })
})

describe('isVendorResponse', () => {
  it('recognises its own vocabulary and nothing else', () => {
    expect(isVendorResponse('ACCEPTED')).toBe(true)
    expect(isVendorResponse('accepted')).toBe(false)
  })
})
