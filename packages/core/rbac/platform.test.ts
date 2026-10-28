import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from './permissions.ts'
import {
  LAST_PLATFORM_OWNER,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_DEFINITIONS,
  type PlatformAssignmentSummary,
  canPlatform,
  isPlatformPermission,
  platformDeactivationRefusal,
  platformGrantRefusal,
  platformRevokeRefusal,
} from './platform.ts'

const NOW = 1_800_000_000_000
const fresh = NOW - 60_000
const stale = NOW - 11 * 60_000
const role = (key: keyof typeof PLATFORM_ROLE_DEFINITIONS) => ({
  roleKey: key,
  permissions: PLATFORM_ROLE_DEFINITIONS[key].permissions,
})

describe('the platform catalogue (§3.1)', () => {
  it('shares no string with the org catalogue', () => {
    const org = new Set<string>(PERMISSIONS)
    expect(PLATFORM_PERMISSIONS.filter((p) => org.has(p))).toEqual([])
    expect(PERMISSIONS.filter((p) => isPlatformPermission(p))).toEqual([])
  })

  it('every seeded role carries only catalogue permissions', () => {
    for (const { permissions } of Object.values(PLATFORM_ROLE_DEFINITIONS)) {
      expect(permissions.filter((p) => !isPlatformPermission(p))).toEqual([])
    }
  })

  it('keeps money, lifecycle, access and law on the owner alone', () => {
    const ownerOnly = ['org.feeSet', 'org.freeze', 'org.offboard', 'platformAdmin.manage', 'jurisdiction.publish', 'org.create']
    for (const key of ['platform_support', 'platform_viewer'] as const) {
      expect(PLATFORM_ROLE_DEFINITIONS[key].permissions.filter((p) => ownerOnly.includes(p))).toEqual([])
    }
  })
})

describe('canPlatform (§3.3)', () => {
  it('refuses an inactive admin whatever they hold', () => {
    const admin = { active: false, mfaVerifiedAt: fresh, assignments: [role('platform_owner')] }
    expect(canPlatform(admin, 'org.read', NOW)).toEqual({ allowed: false, reason: 'inactive' })
  })

  it('allows only what a live assignment carries', () => {
    const viewer = { active: true, mfaVerifiedAt: fresh, assignments: [role('platform_viewer')] }
    expect(canPlatform(viewer, 'platformAudit.read', NOW)).toEqual({ allowed: true })
    expect(canPlatform(viewer, 'job.rerun', NOW)).toEqual({ allowed: false, reason: 'no_permission' })
    const nobody = { active: true, mfaVerifiedAt: fresh, assignments: [] }
    expect(canPlatform(nobody, 'org.read', NOW)).toEqual({ allowed: false, reason: 'no_permission' })
  })

  it('wants a fresh code for a step-up permission, and only for one', () => {
    const owner = { active: true, mfaVerifiedAt: stale, assignments: [role('platform_owner')] }
    expect(canPlatform(owner, 'platformAdmin.manage', NOW)).toEqual({ allowed: false, reason: 'stepup_required' })
    expect(canPlatform(owner, 'org.read', NOW)).toEqual({ allowed: true })
    expect(canPlatform({ ...owner, mfaVerifiedAt: fresh }, 'platformAdmin.manage', NOW)).toEqual({ allowed: true })
  })

  it('answers no_permission before stepup_required, so a stale viewer is not sent to prove a code for nothing', () => {
    const viewer = { active: true, mfaVerifiedAt: stale, assignments: [role('platform_viewer')] }
    expect(canPlatform(viewer, 'org.feeSet', NOW)).toEqual({ allowed: false, reason: 'no_permission' })
  })
})

const a = (id: string, adminId: string, roleKey: string, extra: Partial<PlatformAssignmentSummary> = {}) => ({
  id,
  platformAdminId: adminId,
  roleKey,
  revokedAt: null,
  adminActive: true,
  ...extra,
})

describe('the last platform owner (§3.3), as lists', () => {
  it('refuses revoking the last live owner, even your own', () => {
    expect(platformRevokeRefusal('o1', [a('o1', 'shane', 'platform_owner')])).toBe(LAST_PLATFORM_OWNER)
  })

  it('allows it once a second active owner exists, including self-revocation', () => {
    const list = [a('o1', 'shane', 'platform_owner'), a('o2', 'kim', 'platform_owner')]
    expect(platformRevokeRefusal('o1', list)).toBeNull()
  })

  it('does not count an owner whose admin is deactivated, or a revoked grant', () => {
    const list = [
      a('o1', 'shane', 'platform_owner'),
      a('o2', 'kim', 'platform_owner', { adminActive: false }),
      a('o3', 'lee', 'platform_owner', { revokedAt: new Date() }),
    ]
    expect(platformRevokeRefusal('o1', list)).toBe(LAST_PLATFORM_OWNER)
    // Revoking the deactivated admin's grant leaves the live owner in place.
    expect(platformRevokeRefusal('o2', list)).toBeNull()
  })

  it('never refuses a non-owner role on owner grounds', () => {
    const list = [a('o1', 'shane', 'platform_owner'), a('v1', 'shane', 'platform_viewer')]
    expect(platformRevokeRefusal('v1', list)).toBeNull()
  })

  it('refuses a missing or already revoked assignment', () => {
    expect(platformRevokeRefusal('nope', [])).toMatch(/no longer exists/)
    expect(platformRevokeRefusal('o1', [a('o1', 'kim', 'platform_owner', { revokedAt: new Date() })])).toMatch(/already/)
  })

  it('refuses deactivating yourself, and the admin who holds every live owner grant', () => {
    const list = [a('o1', 'shane', 'platform_owner'), a('s1', 'kim', 'platform_support')]
    expect(platformDeactivationRefusal('shane', 'shane', list)).toMatch(/your own account/)
    expect(platformDeactivationRefusal('shane', 'kim', list)).toBe(LAST_PLATFORM_OWNER)
    expect(platformDeactivationRefusal('kim', 'shane', list)).toBeNull()
  })

  it('refuses granting to yourself', () => {
    expect(platformGrantRefusal('shane', 'shane')).toMatch(/your own roles/)
    expect(platformGrantRefusal('kim', 'shane')).toBeNull()
  })
})
