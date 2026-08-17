import { describe, expect, it } from 'vitest'
import {
  isOptOutErrorCode,
  mapDeliveryStatus,
  mapResendEventStatus,
  shouldApplyStatus,
} from './delivery-status.ts'

describe('mapDeliveryStatus', () => {
  it('maps the statuses that carry a verdict', () => {
    expect(mapDeliveryStatus('sent')).toBe('SENT')
    expect(mapDeliveryStatus('delivered')).toBe('DELIVERED')
    expect(mapDeliveryStatus('read')).toBe('READ')
    expect(mapDeliveryStatus('undelivered')).toBe('FAILED')
    expect(mapDeliveryStatus('failed')).toBe('FAILED')
  })

  it('ignores the ones that only mean "still in flight"', () => {
    // Writing these would move a row backwards from SENT for no gain.
    expect(mapDeliveryStatus('accepted')).toBeNull()
    expect(mapDeliveryStatus('queued')).toBeNull()
    expect(mapDeliveryStatus('sending')).toBeNull()
    expect(mapDeliveryStatus('something-new-twilio-invented')).toBeNull()
  })

  it('does not care about case or padding', () => {
    expect(mapDeliveryStatus(' Delivered ')).toBe('DELIVERED')
  })
})

describe('shouldApplyStatus', () => {
  it('moves a record forwards', () => {
    expect(shouldApplyStatus('DELIVERED', 'SENT')).toBe(true)
    expect(shouldApplyStatus('READ', 'DELIVERED')).toBe(true)
    expect(shouldApplyStatus('FAILED', 'SENT')).toBe(true)
  })

  it('REFUSES to walk it backwards', () => {
    // Callbacks are not ordered: Twilio promises each one arrives, not that
    // `sent` arrives before `delivered`. A retried `sent` landing after a
    // `delivered` must not undo it - the same out-of-order hazard R-042 fixed
    // in the Stripe projection, where a stale decline reversed a payment that
    // had already cleared.
    expect(shouldApplyStatus('SENT', 'DELIVERED')).toBe(false)
    expect(shouldApplyStatus('DELIVERED', 'READ')).toBe(false)
    expect(shouldApplyStatus('SENT', 'FAILED')).toBe(false)
    expect(shouldApplyStatus('DELIVERED', 'FAILED')).toBe(false)
  })

  it('is idempotent for a redelivered callback', () => {
    expect(shouldApplyStatus('DELIVERED', 'DELIVERED')).toBe(false)
  })

  it('never resurrects a decision made BEFORE sending', () => {
    // SUPPRESSED means we chose not to send; DEFERRED means we have not sent
    // yet. A callback about either is about a message this row is not
    // describing - and overwriting a SUPPRESSED row would erase the reason.
    expect(shouldApplyStatus('DELIVERED', 'SUPPRESSED')).toBe(false)
    expect(shouldApplyStatus('SENT', 'SUPPRESSED')).toBe(false)
    expect(shouldApplyStatus('FAILED', 'DEFERRED')).toBe(false)
  })
})

describe('mapResendEventStatus (R-054)', () => {
  it('maps the two events this build acts on', () => {
    expect(mapResendEventStatus('email.delivered')).toBe('DELIVERED')
    expect(mapResendEventStatus('email.bounced')).toBe('BOUNCED')
  })

  it('ignores events that carry no verdict this column can hold', () => {
    expect(mapResendEventStatus('email.sent')).toBeNull()
    expect(mapResendEventStatus('email.delivery_delayed')).toBeNull()
    expect(mapResendEventStatus('email.complained')).toBeNull()
    expect(mapResendEventStatus('email.opened')).toBeNull()
    expect(mapResendEventStatus('email.clicked')).toBeNull()
    expect(mapResendEventStatus('something-new-resend-invented')).toBeNull()
  })

  it('does not care about case or padding', () => {
    expect(mapResendEventStatus(' Email.Bounced ')).toBe('BOUNCED')
  })
})

describe('shouldApplyStatus with a bounce in the mix', () => {
  it('lets a bounce overwrite a plain SENT or DELIVERED', () => {
    expect(shouldApplyStatus('BOUNCED', 'SENT')).toBe(true)
    expect(shouldApplyStatus('BOUNCED', 'DELIVERED')).toBe(true)
  })

  it('outranks a generic FAILED, and is not itself overwritten by one', () => {
    // A bounce is more specific than a generic failure - it must be able to
    // record over one that already landed, and a later generic FAILED must
    // not erase the more specific fact once it's recorded.
    expect(shouldApplyStatus('BOUNCED', 'FAILED')).toBe(true)
    expect(shouldApplyStatus('FAILED', 'BOUNCED')).toBe(false)
  })

  it('is idempotent for a redelivered bounce callback', () => {
    expect(shouldApplyStatus('BOUNCED', 'BOUNCED')).toBe(false)
  })
})

describe('isOptOutErrorCode', () => {
  it('recognises 21610, the code that means they replied STOP', () => {
    // This is how we learn about an opt-out the carrier absorbed and never
    // forwarded - the common case, not the edge one.
    expect(isOptOutErrorCode('21610')).toBe(true)
    expect(isOptOutErrorCode(' 21610 ')).toBe(true)
  })

  it('does NOT treat an unreachable handset as an opt-out', () => {
    // Silently unsubscribing somebody whose phone was merely off would be the
    // same false-record defect this whole item exists to close.
    expect(isOptOutErrorCode('30003')).toBe(false)
    expect(isOptOutErrorCode('30005')).toBe(false)
    expect(isOptOutErrorCode('21211')).toBe(false)
    expect(isOptOutErrorCode(null)).toBe(false)
    expect(isOptOutErrorCode(undefined)).toBe(false)
  })
})
