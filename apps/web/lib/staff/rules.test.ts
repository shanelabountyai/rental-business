import { describe, expect, it } from 'vitest'
import {
  type AssignmentSummary,
  activeOwnerAssignments,
  deactivationRefusal,
  isStaffRoleKey,
  revokeRefusal,
} from './rules.ts'

// Pure predicates, no database: the point of splitting them out of the server
// action is that the lockout branches are reachable without a session.

const assignment = (over: Partial<AssignmentSummary> = {}): AssignmentSummary => ({
  id: 'a1',
  staffUserId: 's1',
  roleKey: 'owner',
  revokedAt: null,
  ...over,
})

describe('activeOwnerAssignments', () => {
  it('ignores revoked owner grants', () => {
    const rows = [
      assignment({ id: 'a1' }),
      assignment({ id: 'a2', revokedAt: new Date() }),
      assignment({ id: 'a3', roleKey: 'manager' }),
    ]
    expect(activeOwnerAssignments(rows).map((a) => a.id)).toEqual(['a1'])
  })
})

describe('revokeRefusal', () => {
  it('refuses the last active owner assignment', () => {
    const rows = [assignment({ id: 'a1' }), assignment({ id: 'a2', roleKey: 'manager' })]
    expect(revokeRefusal('a1', rows)).toMatch(/last owner assignment/)
  })

  it('allows revoking an owner while another owner remains', () => {
    const rows = [assignment({ id: 'a1' }), assignment({ id: 'a2', staffUserId: 's2' })]
    expect(revokeRefusal('a1', rows)).toBeNull()
  })

  it('does not count a revoked owner as the survivor', () => {
    const rows = [
      assignment({ id: 'a1' }),
      assignment({ id: 'a2', staffUserId: 's2', revokedAt: new Date() }),
    ]
    expect(revokeRefusal('a1', rows)).toMatch(/last owner assignment/)
  })

  it('allows revoking a non-owner grant regardless', () => {
    const rows = [assignment({ id: 'a1', roleKey: 'manager' })]
    expect(revokeRefusal('a1', rows)).toBeNull()
  })

  it('refuses an assignment that is already revoked', () => {
    const rows = [assignment({ id: 'a1', roleKey: 'manager', revokedAt: new Date() })]
    expect(revokeRefusal('a1', rows)).toMatch(/already revoked/)
  })

  it('refuses an assignment that is not in the set', () => {
    expect(revokeRefusal('nope', [assignment()])).toMatch(/no longer exists/)
  })
})

describe('deactivationRefusal', () => {
  it('refuses deactivating yourself', () => {
    expect(deactivationRefusal('s1', 's1', [assignment()])).toMatch(/your own account/)
  })

  it('refuses deactivating the only active owner', () => {
    const rows = [assignment({ id: 'a1', staffUserId: 's1' })]
    expect(deactivationRefusal('s1', 's2', rows)).toMatch(/only active owner/)
  })

  it('allows it once a second owner exists', () => {
    const rows = [
      assignment({ id: 'a1', staffUserId: 's1' }),
      assignment({ id: 'a2', staffUserId: 's2' }),
    ]
    expect(deactivationRefusal('s1', 's3', rows)).toBeNull()
  })

  it('allows deactivating somebody who is not an owner', () => {
    const rows = [
      assignment({ id: 'a1', staffUserId: 's1' }),
      assignment({ id: 'a2', staffUserId: 's2', roleKey: 'manager' }),
    ]
    expect(deactivationRefusal('s2', 's3', rows)).toBeNull()
  })
})

describe('isStaffRoleKey', () => {
  it('accepts the four staff roles and refuses the tenant-side ones', () => {
    expect(isStaffRoleKey('manager')).toBe(true)
    expect(isStaffRoleKey('owner')).toBe(true)
    expect(isStaffRoleKey('tenant')).toBe(false)
    expect(isStaffRoleKey('guarantor')).toBe(false)
    expect(isStaffRoleKey('')).toBe(false)
  })
})
