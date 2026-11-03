import { describe, expect, it } from 'vitest'
import type { Actor } from './can.ts'
import { can } from './can.ts'
import { ROLE_DEFINITIONS } from './permissions.ts'
import {
  FREEZE_WINDOW_DAYS,
  actorForOrgStatus,
  freezeRefusal,
  purgeDate,
  restoreRefusal,
  scheduleOffboardRefusal,
  slugConfirmRefusal,
} from './org-lifecycle.ts'

const owner: Actor = {
  id: 'u1',
  orgId: 'o1',
  kind: 'staff',
  active: true,
  mfaVerified: true,
  assignments: [{ orgId: 'o1', roleKey: 'owner', permissions: ROLE_DEFINITIONS.owner.permissions, legalEntityId: null, propertyId: null }],
  leaseIds: [],
  ceilings: { approveWorkOrderCents: null, waiveFeeCents: null },
}

describe('a frozen org is read-only by permissions', () => {
  const frozen = actorForOrgStatus(owner, 'FROZEN')

  it('keeps every read and the two exports', () => {
    for (const p of ['lease.read', 'ledger.read', 'audit.read', 'report.financial', 'property.export'] as const) {
      expect(can(frozen, p).allowed, p).toBe(true)
    }
  })

  it('refuses every write', () => {
    for (const p of ['lease.write', 'payment.record', 'message.send', 'staff.manage', 'ledger.adjust', 'accesscode.reveal'] as const) {
      expect(can(frozen, p).allowed, p).toBe(false)
    }
    expect(frozen.readOnly).toBe(true)
  })

  it('leaves an offboarded org nothing, and a live one untouched', () => {
    expect(can(actorForOrgStatus(owner, 'OFFBOARDED'), 'lease.read').allowed).toBe(false)
    expect(actorForOrgStatus(owner, 'ACTIVE')).toBe(owner)
    expect(actorForOrgStatus(owner, 'PROVISIONING')).toBe(owner)
  })
})

describe('the transitions', () => {
  it('freezes only a live org', () => {
    expect(freezeRefusal('ACTIVE')).toBeNull()
    expect(freezeRefusal('FROZEN')).toMatch(/already frozen/)
    expect(freezeRefusal('PROVISIONING')).toMatch(/not live/)
    expect(freezeRefusal('OFFBOARDED')).toMatch(/offboarded/)
  })

  it('restores only a frozen org', () => {
    expect(restoreRefusal('FROZEN')).toBeNull()
    expect(restoreRefusal('ACTIVE')).toMatch(/not frozen/)
    expect(restoreRefusal('OFFBOARDED')).toMatch(/cannot be restored/)
  })

  it('schedules offboarding once, from FROZEN only', () => {
    expect(scheduleOffboardRefusal('FROZEN', null)).toBeNull()
    expect(scheduleOffboardRefusal('FROZEN', new Date())).toMatch(/already scheduled/)
    expect(scheduleOffboardRefusal('ACTIVE', null)).toMatch(/Only a frozen/)
  })

  it('counts the window from the freeze (D-325)', () => {
    expect(FREEZE_WINDOW_DAYS).toBe(90)
    expect(purgeDate(new Date('2026-11-01T00:00:00Z')).toISOString()).toBe('2027-01-30T00:00:00.000Z')
  })

  it('asks for the slug exactly', () => {
    expect(slugConfirmRefusal(' acme ', 'acme')).toBeNull()
    expect(slugConfirmRefusal('Acme', 'acme')).not.toBeNull()
  })
})
