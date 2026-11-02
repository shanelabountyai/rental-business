import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { type Actor, supportActor, supportGrantStatus } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { cache } from 'react'
import { hostOrgId } from '@/lib/auth/org.ts'
import { redeemToken } from '@/lib/auth/store.ts'
import { type SupportClaims, readSupportClaims } from '@/lib/support/cookie.ts'
import { GRANT_STATE } from '@/lib/support/grants.ts'

// The support session (PRD 11 §4.7, R-295b): a platform admin inside one org
// under a live grant. Entered by a single-use token on the org's own host,
// held in a host-only cookie, and re-checked against the grant on EVERY
// request - grant not ended, not expired, its admin active, this host its org.
// The cookie only says which grant; the grant row says whether it still opens.

/// Why a session no longer opens anything, for `/support/ended` to say.
export type SupportEndReason =
  | 'ended_by_support'
  | 'revoked'
  | 'expired'
  | 'admin_deactivated'
  | 'wrong_host'
  | 'invalid'

const LIVE_GRANT = {
  ...GRANT_STATE,
  id: true,
  orgId: true,
  platformAdminId: true,
  endedByType: true,
  organization: { select: { name: true } },
  platformAdmin: { select: { name: true, active: true, sessionsValidFrom: true } },
} as const

export type LiveGrant = {
  id: string
  orgId: string
  platformAdminId: string
  expiresAt: Date
  organization: { name: string }
  platformAdmin: { name: string }
}

/**
 * PLAT-05 and PLAT-09 in one predicate. `hostOrg` is the org this request's
 * host names (null for none, the console's host included), passed in so the
 * suites can ask about any host.
 */
export async function supportSessionIsStillValid(
  claims: SupportClaims,
  hostOrg: string | null,
  now = new Date(),
): Promise<{ ok: true; grant: LiveGrant } | { ok: false; why: SupportEndReason }> {
  if (hostOrg !== claims.orgId) return { ok: false, why: 'wrong_host' }
  const grant = await prisma.supportAccessGrant.findUnique({ where: { id: claims.grantId }, select: LIVE_GRANT })
  if (!grant || grant.orgId !== claims.orgId || grant.platformAdminId !== claims.adminId) return { ok: false, why: 'invalid' }
  // Deactivation ends every grant in the same transaction (D-380 item 12);
  // the watermark is the admin's "sign out everywhere", which ends this too.
  const admin = grant.platformAdmin
  if (!admin.active || admin.sessionsValidFrom.getTime() > claims.issuedAt) return { ok: false, why: 'admin_deactivated' }
  switch (supportGrantStatus(grant, now)) {
    case 'live':
      return { ok: true, grant: { ...grant, expiresAt: grant.expiresAt! } }
    case 'expired':
      return { ok: false, why: 'expired' }
    case 'ended':
      return {
        ok: false,
        why:
          grant.endedByType === 'STAFF'
            ? 'revoked'
            : grant.endedByType === 'PLATFORM'
              ? 'ended_by_support'
              : grant.endedByType === 'SYSTEM'
                ? 'admin_deactivated'
                : 'expired',
      }
    default:
      return { ok: false, why: 'invalid' }
  }
}

export type SupportSession =
  | { live: true; claims: SupportClaims; grant: LiveGrant; actor: Actor }
  | { live: false; claims: SupportClaims; why: SupportEndReason }

/// This request's support session: null when the browser holds none, else
/// live or ended (with why). Per-request memoized, never across requests.
export const currentSupportSession = cache(async (): Promise<SupportSession | null> => {
  const claims = await readSupportClaims()
  if (!claims) return null
  const check = await supportSessionIsStillValid(claims, await hostOrgId())
  return check.ok
    ? { live: true, claims, grant: check.grant, actor: supportActor(check.grant) }
    : { live: false, claims, why: check.why }
})

/**
 * Redeems an entry token on this host (§4.7). The token is burned first, so a
 * second redemption fails whatever happens next; then the grant must be live,
 * its admin active, and this host the grant's org - a token from org A's grant
 * opens nothing on org B's host (PLAT-09). Returns the claims to seal and how
 * long the cookie may live, or null.
 */
export async function enterSupportSession(
  rawToken: string,
  hostOrg: string | null,
  request: { ipAddress: string | null; userAgent: string | null },
  now = new Date(),
): Promise<{ claims: SupportClaims; maxAgeSeconds: number } | null> {
  if (!rawToken) return null
  const redeemed = await redeemToken(rawToken, { purpose: 'SUPPORT_ENTRY', subjectType: 'SupportAccessGrant' }, now)
  if (!redeemed.ok) return null
  const grant = await prisma.supportAccessGrant.findUnique({
    where: { id: redeemed.subjectId },
    select: { id: true, orgId: true, platformAdminId: true },
  })
  if (!grant) return null
  const claims: SupportClaims = { grantId: grant.id, adminId: grant.platformAdminId, orgId: grant.orgId, issuedAt: now.getTime() }
  const check = await supportSessionIsStillValid(claims, hostOrg, now)
  if (!check.ok) return null
  await recordAudit(prisma, {
    actor: { type: 'PLATFORM', ref: grant.platformAdminId, ...request },
    action: 'support_grant.entered',
    entityType: 'SupportAccessGrant',
    entityId: grant.id,
    orgId: grant.orgId,
    supportGrantId: grant.id,
  })
  return { claims, maxAgeSeconds: Math.max(1, Math.ceil((check.grant.expiresAt.getTime() - now.getTime()) / 1000)) }
}
