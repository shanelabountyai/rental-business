import { describe, expect, it } from 'vitest'
import { lifecycleDecision, requiresStripeCall } from './index.ts'

// The branches that matter: billing somebody who moved out, and NOT billing
// somebody who did not.

function lease(over: Partial<Parameters<typeof lifecycleDecision>[0]> = {}) {
  return {
    status: 'ACTIVE',
    rentCents: 150_000,
    stripeSubscriptionId: 'sub_1',
    collectionPaused: false,
    moveOutAt: null,
    ...over,
  }
}

function stripe(over: Partial<NonNullable<Parameters<typeof lifecycleDecision>[1]>> = {}) {
  return { status: 'active', amountCents: 150_000, cancelAt: null, ...over }
}

describe('the tenancy is over', () => {
  it('CANCELS for an ended lease', () => {
    const decision = lifecycleDecision(lease({ status: 'ENDED' }), stripe())
    expect(decision.action).toBe('cancel')
  })

  it('cancels for a terminated lease too', () => {
    expect(lifecycleDecision(lease({ status: 'TERMINATED' }), stripe()).action).toBe(
      'cancel',
    )
  })

  it('cancels EFFECTIVE AT the move-out date, not immediately', () => {
    // A tenancy ending on the last day of a month should bill that month,
    // not be cut off mid-period.
    const moveOutAt = new Date('2026-08-31T12:00:00Z')
    const decision = lifecycleDecision(lease({ status: 'ENDED', moveOutAt }), stripe())
    expect(decision.effectiveAt).toEqual(moveOutAt)
  })

  it('does nothing when Stripe already cancelled it', () => {
    expect(
      lifecycleDecision(lease({ status: 'ENDED' }), stripe({ status: 'canceled' })).action,
    ).toBe('none')
  })

  it('does nothing when a cancellation is already scheduled', () => {
    const decision = lifecycleDecision(
      lease({ status: 'ENDED' }),
      stripe({ cancelAt: new Date('2026-08-31') }),
    )
    expect(decision.action).toBe('none')
    expect(decision.reason).toMatch(/Already scheduled/)
  })

  it('does nothing for an ended lease that never had a subscription', () => {
    expect(
      lifecycleDecision(lease({ status: 'ENDED', stripeSubscriptionId: null }), null).action,
    ).toBe('none')
  })

  it('CANCELS EVEN IF THE RENT ALSO CHANGED', () => {
    // The ordering assertion, and the one that matters most. Checking the
    // rent first would update the price on a subscription that should be
    // cancelled - billing somebody who has moved out, at a new rate.
    const decision = lifecycleDecision(
      lease({ status: 'ENDED', rentCents: 200_000 }),
      stripe({ amountCents: 150_000 }),
    )
    expect(decision.action).toBe('cancel')
  })
})

describe('not live yet', () => {
  it('does nothing for a draft', () => {
    const decision = lifecycleDecision(
      lease({ status: 'DRAFT', stripeSubscriptionId: null }),
      null,
    )
    expect(decision.action).toBe('none')
    expect(decision.reason).toMatch(/not live yet/)
  })

  it('does nothing for a lease awaiting signature', () => {
    expect(
      lifecycleDecision(
        lease({ status: 'PENDING_SIGNATURE', stripeSubscriptionId: null }),
        null,
      ).action,
    ).toBe('none')
  })
})

describe('live tenancies', () => {
  it('provisions a live lease with no subscription', () => {
    expect(
      lifecycleDecision(lease({ stripeSubscriptionId: null }), null).action,
    ).toBe('provision')
  })

  it('re-provisions a live lease whose subscription was cancelled behind our back', () => {
    const decision = lifecycleDecision(lease(), stripe({ status: 'canceled' }))
    expect(decision.action).toBe('provision')
    expect(decision.reason).toMatch(/needs re-provisioning/)
  })

  it('does nothing when Stripe agrees', () => {
    const decision = lifecycleDecision(lease(), stripe())
    expect(decision.action).toBe('none')
    expect(requiresStripeCall(decision)).toBe(false)
  })

  it('updates the price when the rent changed', () => {
    const decision = lifecycleDecision(
      lease({ rentCents: 165_000 }),
      stripe({ amountCents: 150_000 }),
    )
    expect(decision.action).toBe('update_price')
    expect(requiresStripeCall(decision)).toBe(true)
  })

  it('does NOT update when Stripe reports no amount', () => {
    // Absent is not zero and is not a disagreement - re-pricing on a missing
    // figure would rewrite a subscription for no reason.
    expect(
      lifecycleDecision(lease(), stripe({ amountCents: null })).action,
    ).toBe('none')
  })
})

describe('collection holds (PAY-12)', () => {
  it('pauses when the lease is on hold and Stripe is not', () => {
    expect(
      lifecycleDecision(lease({ collectionPaused: true }), stripe()).action,
    ).toBe('pause')
  })

  it('resumes when the hold is lifted', () => {
    expect(
      lifecycleDecision(lease({ collectionPaused: false }), stripe({ status: 'paused' }))
        .action,
    ).toBe('resume')
  })

  it('does nothing when both already agree it is paused', () => {
    expect(
      lifecycleDecision(lease({ collectionPaused: true }), stripe({ status: 'paused' }))
        .action,
    ).toBe('none')
  })

  it('pauses BEFORE considering a rent change', () => {
    // A lease under a legal-action hold must stop collecting first; changing
    // the price on it would generate an invoice the hold exists to prevent.
    const decision = lifecycleDecision(
      lease({ collectionPaused: true, rentCents: 200_000 }),
      stripe({ amountCents: 150_000 }),
    )
    expect(decision.action).toBe('pause')
  })
})

describe('when Stripe has not been asked', () => {
  it('still provisions a live lease with no subscription', () => {
    expect(lifecycleDecision(lease({ stripeSubscriptionId: null }), null).action).toBe(
      'provision',
    )
  })

  it('still cancels an ended tenancy', () => {
    expect(lifecycleDecision(lease({ status: 'ENDED' }), null).action).toBe('cancel')
  })

  it('does not guess at a rent difference', () => {
    // Null is "we have not asked", not "Stripe has nothing" - and acting on
    // the difference would mean acting on an assumption.
    expect(lifecycleDecision(lease({ rentCents: 999_999 }), null).action).toBe('none')
  })
})
