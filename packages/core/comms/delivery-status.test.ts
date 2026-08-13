import { describe, expect, it } from 'vitest'
import {
  isOptOutErrorCode,
  mapDeliveryStatus,
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
