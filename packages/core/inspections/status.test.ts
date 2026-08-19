import { describe, expect, it } from 'vitest'
import {
  canEditItem,
  canFinishInspection,
  canLockInspection,
  canRecordSignature,
  inspectionStatus,
} from './status.ts'

const NONE = { scheduledFor: null, performedAt: null, tenantSignedAt: null, lockedAt: null }

describe('inspectionStatus', () => {
  it('is DRAFT with no facts at all', () => {
    expect(inspectionStatus({ ...NONE, anyItemRecorded: false })).toBe('DRAFT')
  })

  it('is SCHEDULED once a date is set but nothing walked yet', () => {
    expect(inspectionStatus({ ...NONE, scheduledFor: new Date(), anyItemRecorded: false })).toBe(
      'SCHEDULED',
    )
  })

  it('is IN_PROGRESS once at least one item has a condition', () => {
    expect(inspectionStatus({ ...NONE, anyItemRecorded: true })).toBe('IN_PROGRESS')
  })

  it('is PENDING_SIGNATURE once performed', () => {
    expect(
      inspectionStatus({ ...NONE, performedAt: new Date(), anyItemRecorded: true }),
    ).toBe('PENDING_SIGNATURE')
  })

  it('is SIGNED once signed but not yet locked', () => {
    expect(
      inspectionStatus({
        ...NONE,
        performedAt: new Date(),
        tenantSignedAt: new Date(),
        anyItemRecorded: true,
      }),
    ).toBe('SIGNED')
  })

  it('is LOCKED once locked, whatever else is or is not set - the terminal fact wins', () => {
    expect(
      inspectionStatus({ ...NONE, lockedAt: new Date(), anyItemRecorded: false }),
    ).toBe('LOCKED')
  })
})

describe('canEditItem', () => {
  it('allows an edit before locking', () => {
    expect(canEditItem({ lockedAt: null }).allowed).toBe(true)
  })

  it('refuses once locked', () => {
    const decision = canEditItem({ lockedAt: new Date() })
    expect(decision.allowed).toBe(false)
    expect(decision.message).toMatch(/locked/)
  })
})

describe('canFinishInspection', () => {
  it('refuses with no items at all', () => {
    expect(canFinishInspection({ lockedAt: null, performedAt: null, items: [] }).allowed).toBe(
      false,
    )
  })

  it('refuses while any item is unrecorded, and says how many', () => {
    const decision = canFinishInspection({
      lockedAt: null,
      performedAt: null,
      items: [{ condition: 'GOOD' }, { condition: null }, { condition: null }],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.message).toContain('2 items')
  })

  it('allows once every item has a condition', () => {
    const decision = canFinishInspection({
      lockedAt: null,
      performedAt: null,
      items: [{ condition: 'GOOD' }, { condition: 'FAIR' }],
    })
    expect(decision.allowed).toBe(true)
  })

  it('refuses if already performed', () => {
    const decision = canFinishInspection({
      lockedAt: null,
      performedAt: new Date(),
      items: [{ condition: 'GOOD' }],
    })
    expect(decision.allowed).toBe(false)
  })

  it('refuses if locked', () => {
    const decision = canFinishInspection({
      lockedAt: new Date(),
      performedAt: null,
      items: [{ condition: 'GOOD' }],
    })
    expect(decision.allowed).toBe(false)
  })
})

describe('canRecordSignature', () => {
  it('refuses before performed', () => {
    expect(
      canRecordSignature({ performedAt: null, tenantSignedAt: null, lockedAt: null }).allowed,
    ).toBe(false)
  })

  it('allows once performed and not yet signed', () => {
    expect(
      canRecordSignature({ performedAt: new Date(), tenantSignedAt: null, lockedAt: null })
        .allowed,
    ).toBe(true)
  })

  it('refuses a second signature', () => {
    expect(
      canRecordSignature({
        performedAt: new Date(),
        tenantSignedAt: new Date(),
        lockedAt: null,
      }).allowed,
    ).toBe(false)
  })

  it('refuses once locked', () => {
    expect(
      canRecordSignature({
        performedAt: new Date(),
        tenantSignedAt: null,
        lockedAt: new Date(),
      }).allowed,
    ).toBe(false)
  })
})

describe('canLockInspection', () => {
  it('refuses before the walk is performed', () => {
    expect(canLockInspection({ performedAt: null, lockedAt: null }).allowed).toBe(false)
  })

  it('allows once performed', () => {
    expect(canLockInspection({ performedAt: new Date(), lockedAt: null }).allowed).toBe(true)
  })

  it('refuses if already locked', () => {
    expect(canLockInspection({ performedAt: new Date(), lockedAt: new Date() }).allowed).toBe(
      false,
    )
  })
})
