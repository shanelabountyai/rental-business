import { describe, expect, it } from 'vitest'
import {
  type RouteCandidate,
  decideRoute,
  formatPhone,
  normalizePhone,
  threadKey,
  validateCallLog,
  validateOutboundMessage,
} from './index.ts'

describe('normalizePhone', () => {
  it('accepts the shapes a NANP number really arrives in', () => {
    for (const input of [
      '+15125550142',
      '5125550142',
      '512-555-0142',
      '(512) 555-0142',
      '512.555.0142',
      '1-512-555-0142',
      '15125550142',
      '  512 555 0142  ',
    ]) {
      expect(normalizePhone(input), input).toBe('+15125550142')
    }
  })

  it('refuses anything it cannot place, rather than guessing', () => {
    for (const input of [
      '',
      '   ',
      null,
      undefined,
      '12345', // short code - never a tenant
      '555-0142', // 7 digits, no area code
      '1-800-FLOWERS',
      'unknown',
      'Anonymous',
      '+15125550142 ext 12', // the extension changes who answers
      '512-555-0142 x12',
      '025125550142', // 12 digits, not NANP
    ]) {
      expect(normalizePhone(input), String(input)).toBeNull()
    }
  })

  it('passes an already-canonical international number through unchanged', () => {
    // Not NANP, but already E.164 - mangling it with the 10/11-digit rules
    // would be worse than leaving it alone.
    expect(normalizePhone('+442071838750')).toBe('+442071838750')
  })

  it('never maps two different numbers onto one canonical form', () => {
    // The property that matters for routing safety: collisions here are
    // cross-tenant leaks.
    const inputs = ['5125550142', '5125550143', '7135550142', '+15125550142']
    const normalized = inputs.map(normalizePhone)
    expect(new Set(normalized).size).toBe(3) // the first and last are the same number
  })

  it('formats for display without changing what is compared', () => {
    expect(formatPhone('+15125550142')).toBe('(512) 555-0142')
    // Anything it cannot format is shown as-is rather than hidden.
    expect(formatPhone('+442071838750')).toBe('+442071838750')
  })
})

describe('threadKey', () => {
  it('is stable for the same participant and property', () => {
    const identity = {
      scope: 'TENANT' as const,
      propertyId: 'prop_1',
      tenantId: 'ten_1',
    }
    expect(threadKey(identity)).toBe(threadKey(identity))
    expect(threadKey(identity)).toBe('tenant:ten_1:property:prop_1')
  })

  it('separates a tenant from a vendor with the same id', () => {
    expect(
      threadKey({ scope: 'TENANT', propertyId: 'p', tenantId: 'x' }),
    ).not.toBe(threadKey({ scope: 'VENDOR', propertyId: 'p', vendorId: 'x' }))
  })

  it('separates the same tenant at two properties', () => {
    // Deliberate - see threadKey's own comment. Thread.propertyId drives every
    // RBAC scope check, so it must never be stale.
    expect(
      threadKey({ scope: 'TENANT', propertyId: 'p1', tenantId: 't' }),
    ).not.toBe(threadKey({ scope: 'TENANT', propertyId: 'p2', tenantId: 't' }))
  })

  it('refuses to build a participant key with no participant', () => {
    expect(() => threadKey({ scope: 'TENANT', propertyId: 'p' })).toThrow(
      /needs a tenantId/,
    )
    expect(() => threadKey({ scope: 'VENDOR', propertyId: 'p' })).toThrow(
      /needs a vendorId/,
    )
  })

  describe('the vendor work-order thread (R-032, COMM-06)', () => {
    it('keys the property-level thread exactly as before with no workOrderId', () => {
      // Unchanged - inbound SMS routing (candidatesForPhone) never supplies
      // one, and that must keep landing in the same thread it always has.
      expect(
        threadKey({ scope: 'VENDOR', propertyId: 'p', vendorId: 'v' }),
      ).toBe('vendor:v:property:p')
    })

    it('keys a DIFFERENT thread once a work order is given', () => {
      const property = threadKey({ scope: 'VENDOR', propertyId: 'p', vendorId: 'v' })
      const job = threadKey({
        scope: 'VENDOR',
        propertyId: 'p',
        vendorId: 'v',
        workOrderId: 'wo_1',
      })
      expect(job).toBe('vendor:v:workorder:wo_1')
      expect(job).not.toBe(property)
    })

    it('separates two concurrent jobs for the same vendor', () => {
      // The whole reason this exists: a vendor with two open jobs at once
      // must not have their conversations about each one mixed together.
      const jobA = threadKey({
        scope: 'VENDOR',
        propertyId: 'p',
        vendorId: 'v',
        workOrderId: 'wo_a',
      })
      const jobB = threadKey({
        scope: 'VENDOR',
        propertyId: 'p',
        vendorId: 'v',
        workOrderId: 'wo_b',
      })
      expect(jobA).not.toBe(jobB)
    })
  })
})

describe('decideRoute', () => {
  const tenant: RouteCandidate = {
    scope: 'TENANT',
    partyId: 'ten_1',
    propertyId: 'prop_1',
  }

  it('routes exactly one match', () => {
    expect(decideRoute([tenant])).toEqual({
      outcome: 'routed',
      candidate: tenant,
    })
  })

  it('refuses zero matches as an unknown sender', () => {
    expect(decideRoute([])).toEqual({
      outcome: 'unrouted',
      reason: 'UNKNOWN_SENDER',
    })
  })

  it('refuses two different people as ambiguous', () => {
    // A couple sharing a handset. Picking one files the conversation into the
    // wrong person's permanent record.
    const other: RouteCandidate = {
      scope: 'TENANT',
      partyId: 'ten_2',
      propertyId: 'prop_1',
    }
    expect(decideRoute([tenant, other])).toEqual({
      outcome: 'unrouted',
      reason: 'AMBIGUOUS',
    })
  })

  it('refuses a tenant and a vendor sharing a number', () => {
    const vendor: RouteCandidate = {
      scope: 'VENDOR',
      partyId: 'ven_1',
      propertyId: 'prop_1',
    }
    expect(decideRoute([tenant, vendor]).outcome).toBe('unrouted')
  })

  it('refuses one party reachable at two properties', () => {
    // The thread key includes the property, and there is no basis to choose.
    const elsewhere: RouteCandidate = { ...tenant, propertyId: 'prop_2' }
    expect(decideRoute([tenant, elsewhere])).toEqual({
      outcome: 'unrouted',
      reason: 'AMBIGUOUS',
    })
  })

  it('routes one party found twice at the same property', () => {
    // Duplicate rows for the same person are not an ambiguity - there is only
    // one candidate answer.
    expect(decideRoute([tenant, { ...tenant }])).toEqual({
      outcome: 'routed',
      candidate: tenant,
    })
  })
})

describe('validateOutboundMessage', () => {
  const base = { threadId: 'thr_1', channel: 'SMS', body: 'On my way' }

  it('accepts a minimal valid message', () => {
    expect(validateOutboundMessage(base)).toEqual([])
  })

  it('rejects an empty body', () => {
    expect(validateOutboundMessage({ ...base, body: '   ' })).toContainEqual(
      expect.objectContaining({ field: 'body' }),
    )
  })

  it('rejects CALL_LOG as an outbound channel', () => {
    // A logged call is a record of something that happened on the phone,
    // never something this product transmits.
    expect(
      validateOutboundMessage({ ...base, channel: 'CALL_LOG' }),
    ).toContainEqual(expect.objectContaining({ field: 'channel' }))
  })

  it('rejects a text too long to send reliably', () => {
    expect(
      validateOutboundMessage({ ...base, body: 'x'.repeat(1601) }),
    ).toContainEqual(expect.objectContaining({ field: 'body' }))
  })

  it('allows the same length by email', () => {
    expect(
      validateOutboundMessage({
        ...base,
        channel: 'EMAIL',
        body: 'x'.repeat(1601),
      }),
    ).toEqual([])
  })
})

describe('validateCallLog', () => {
  const now = new Date('2026-08-05T15:00:00Z')
  const base = {
    threadId: 'thr_1',
    body: 'Agreed the tech comes Tuesday',
    occurredAt: new Date('2026-08-05T14:30:00Z'),
  }

  it('accepts a note about a call earlier today', () => {
    expect(validateCallLog(base, now)).toEqual([])
  })

  it('accepts a note dated well in the past', () => {
    // Writing up an old call is legitimate; the timestamp is the claim, and
    // createdAt records separately when it was typed.
    expect(
      validateCallLog(
        { ...base, occurredAt: new Date('2026-07-01T09:00:00Z') },
        now,
      ),
    ).toEqual([])
  })

  it('refuses a note dated in the future', () => {
    expect(
      validateCallLog(
        { ...base, occurredAt: new Date('2026-08-06T09:00:00Z') },
        now,
      ),
    ).toContainEqual(expect.objectContaining({ field: 'occurredAt' }))
  })

  it('tolerates a minute of clock skew', () => {
    expect(
      validateCallLog(
        { ...base, occurredAt: new Date('2026-08-05T15:00:30Z') },
        now,
      ),
    ).toEqual([])
  })

  it('refuses an unparseable time', () => {
    expect(validateCallLog({ ...base, occurredAt: null }, now)).toContainEqual(
      expect.objectContaining({ field: 'occurredAt' }),
    )
  })

  it('refuses an empty note', () => {
    expect(validateCallLog({ ...base, body: '  ' }, now)).toContainEqual(
      expect.objectContaining({ field: 'body' }),
    )
  })
})
