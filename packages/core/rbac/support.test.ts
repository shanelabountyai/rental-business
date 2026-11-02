import { describe, expect, it } from 'vitest'
import {
  type SupportGrantState,
  approvableMinutes,
  supportAcknowledgeRefusal,
  supportApprovalRefusal,
  supportDenialRefusal,
  supportEndRefusal,
  supportGrantStatus,
  supportRequestRefusal,
} from './support.ts'

const NOW = new Date('2026-11-02T12:00:00Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
const pending: SupportGrantState = { kind: 'REQUESTED', requestedMinutes: 240, approvedAt: null, deniedAt: null, expiresAt: null, endedAt: null }
const live: SupportGrantState = { ...pending, approvedAt: at(-10), expiresAt: at(50) }
const breakGlass: SupportGrantState = { kind: 'BREAK_GLASS', requestedMinutes: 60, approvedAt: null, deniedAt: null, expiresAt: at(30), endedAt: null }

describe('supportGrantStatus (PRD 11 §5.3: liveness is computed)', () => {
  it('reads pending, live, expired, denied and ended', () => {
    expect(supportGrantStatus(pending, NOW)).toBe('pending')
    expect(supportGrantStatus(live, NOW)).toBe('live')
    expect(supportGrantStatus(breakGlass, NOW)).toBe('live')
    // The instant it expires it admits nothing, whether or not the sweep ran.
    expect(supportGrantStatus({ ...live, expiresAt: NOW }, NOW)).toBe('expired')
    expect(supportGrantStatus({ ...pending, deniedAt: NOW }, NOW)).toBe('denied')
    expect(supportGrantStatus({ ...live, endedAt: NOW }, NOW)).toBe('ended')
  })
})

describe('the lifecycle refusals', () => {
  it('asks a request for a 20-character reason and one of the three durations', () => {
    expect(supportRequestRefusal('Tenant ledger looks off for March', 240)).toBeNull()
    expect(supportRequestRefusal('too short', 240)?.reason).toMatch(/20 characters/)
    expect(supportRequestRefusal('Tenant ledger looks off for March', 90)?.minutes).toMatch(/1, 4 or 24/)
  })

  it('approves only a pending request, and never for longer than asked', () => {
    expect(approvableMinutes(240)).toEqual([60, 240])
    expect(supportApprovalRefusal(pending, 240, NOW)).toBeNull()
    expect(supportApprovalRefusal(pending, 60, NOW)).toBeNull()
    expect(supportApprovalRefusal(pending, 1440, NOW)).toMatch(/no longer than/)
    expect(supportApprovalRefusal(live, 60, NOW)).toMatch(/no longer waiting/)
    expect(supportApprovalRefusal(breakGlass, 60, NOW)).toMatch(/no longer waiting/)
  })

  it('denies only a pending request: approved goes to ended, never denied', () => {
    expect(supportDenialRefusal(pending, NOW)).toBeNull()
    expect(supportDenialRefusal(live, NOW)).toMatch(/no longer waiting/)
  })

  it('ends a live grant from either side, and a pending one only from the platform', () => {
    expect(supportEndRefusal(live, 'org', NOW)).toBeNull()
    expect(supportEndRefusal(breakGlass, 'platform', NOW)).toBeNull()
    expect(supportEndRefusal(pending, 'platform', NOW)).toBeNull()
    expect(supportEndRefusal(pending, 'org', NOW)).toMatch(/no longer open/)
    expect(supportEndRefusal({ ...live, expiresAt: at(-1) }, 'org', NOW)).toMatch(/expired/)
    expect(supportEndRefusal({ ...live, endedAt: NOW }, 'platform', NOW)).toMatch(/no longer open/)
  })

  it('acknowledges break-glass once', () => {
    expect(supportAcknowledgeRefusal(breakGlass)).toBeNull()
    expect(supportAcknowledgeRefusal({ ...breakGlass, ownersAcknowledgedAt: NOW })).toMatch(/already/)
    expect(supportAcknowledgeRefusal(live)).toMatch(/Only emergency/)
  })
})
