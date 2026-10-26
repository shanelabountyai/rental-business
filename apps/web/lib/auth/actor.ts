import 'server-only'

import {
  type Actor,
  type Assignment,
  type Permission,
  effectiveCeiling,
  isPermission,
} from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { cache } from 'react'
import { auth } from '@/auth.ts'

// Loads the current Actor from the session. This is the ONE place that turns
// a session into permissions, so there is one place to audit rather than one
// per route.
//
// Wrapped in React's `cache`, so a page that calls requirePermission() and
// then runs three scoped queries pays for one round-trip, not four. The cache
// is per-request and never spans requests, which is what keeps ROLE-06's
// one-minute revocation intact: a permission revoked between two requests is
// gone on the second.
//
// Note what is NOT cached: R-003's jwt callback already re-reads the account
// on every request to check the revocation watermark. Assignments are read
// here on top of that, so a revoked assignment stops granting on the very next
// request without anything having to be invalidated.

/// Permission keys are stored as plain strings in Postgres, so a role row can
/// outlive a permission that has been removed from the vocabulary in code.
/// Unknown keys are dropped rather than trusted - the safe direction, since
/// the alternative is granting something nothing knows how to check.
function knownPermissions(stored: string[]): Permission[] {
  return stored.filter(isPermission)
}

/// Exported for the one caller that has a staff id but no session: R-097c's
/// calendar feed, authorized by a long-lived token in a URL. It passes
/// `mfaVerified: false`, which is the honest value - a link in a calendar
/// app is not a proved second factor - and is safe because the feed reads
/// nothing that needs one.
///
/// The org (R-285b, PRD 10 §1.3): the actor acts in exactly one organisation
/// and only that org's grants are loaded. With no live membership there is no
/// org and no grant, so the actor can do nothing. A session names its org
/// (R-288: the host's, proved at sign-in) and only a live membership in THAT
/// org counts. The calendar feed has no session and passes none, so it takes
/// the earliest live membership - org #0 for every user until R-289 builds its
/// links on the org's host.
export async function loadStaffActor(staffUserId: string, mfaVerified: boolean, orgId?: string) {
  const staffUser = await prisma.staffUser.findUnique({
    where: { id: staffUserId },
    select: {
      id: true,
      active: true,
      approveWorkOrderCents: true,
      waiveFeeCents: true,
      // Removed members keep their row for history and must never act.
      orgMemberships: {
        where: { removedAt: null, ...(orgId === undefined ? {} : { orgId }) },
        orderBy: { joinedAt: 'asc' },
        select: { orgId: true },
        take: 1,
      },
      assignments: {
        // Revoked grants are kept for history (ROLE-06) and must never grant.
        where: { revokedAt: null },
        select: {
          orgId: true,
          legalEntityId: true,
          propertyId: true,
          role: {
            select: {
              key: true,
              permissions: true,
              defaultApproveWorkOrderCents: true,
              defaultWaiveFeeCents: true,
            },
          },
        },
      },
    },
  })
  if (!staffUser) return null

  // '' is no organisation's id, so a member of none matches no row anywhere.
  const memberOf = staffUser.orgMemberships[0]?.orgId ?? ''
  const inOrg = staffUser.assignments.filter((row) => row.orgId === memberOf)

  const assignments: Assignment[] = inOrg.map((row) => ({
    orgId: row.orgId,
    roleKey: row.role.key,
    permissions: knownPermissions(row.role.permissions),
    legalEntityId: row.legalEntityId,
    propertyId: row.propertyId,
  }))

  const roles = inOrg.map((row) => row.role)

  const actor: Actor = {
    id: staffUser.id,
    orgId: memberOf,
    kind: 'staff',
    active: staffUser.active,
    mfaVerified,
    assignments,
    leaseIds: [],
    ceilings: {
      approveWorkOrderCents: effectiveCeiling(
        staffUser.approveWorkOrderCents,
        roles.map((role) => role.defaultApproveWorkOrderCents),
      ),
      waiveFeeCents: effectiveCeiling(
        staffUser.waiveFeeCents,
        roles.map((role) => role.defaultWaiveFeeCents),
      ),
    },
  }
  return actor
}

async function loadTenantActor(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      orgId: true,
      active: true,
      leaseTenants: { select: { leaseId: true } },
    },
  })
  if (!tenant) return null

  const role = await prisma.role.findUnique({ where: { key: 'tenant' } })
  if (!role) {
    // The seed did not run. Failing closed rather than inventing a permission
    // set in code: a tenant with silently-guessed permissions is worse than a
    // tenant who cannot sign in.
    throw new Error(
      'The `tenant` role is missing. Run `npm run db:seed` - roles are data (D-5).',
    )
  }

  const actor: Actor = {
    id: tenant.id,
    // A tenant row belongs to one org (D-318), so the tenant acts in it.
    orgId: tenant.orgId,
    kind: 'tenant',
    active: tenant.active,
    // Tenants have no second factor; magic links are the whole credential
    // (ROLE-05), and no permission a tenant holds is on the privileged list.
    mfaVerified: false,
    assignments: [
      {
        orgId: tenant.orgId,
        roleKey: role.key,
        permissions: knownPermissions(role.permissions),
        legalEntityId: null,
        propertyId: null,
      },
    ],
    leaseIds: tenant.leaseTenants.map((link) => link.leaseId),
    ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 },
  }
  return actor
}

/// R-165. A guarantor guarantees exactly one lease (Guarantor.leaseId), so
/// their scope is a single-element `leaseIds` rather than a join table.
async function loadGuarantorActor(guarantorId: string) {
  const guarantor = await prisma.guarantor.findUnique({
    where: { id: guarantorId },
    select: { id: true, orgId: true, active: true, leaseId: true },
  })
  if (!guarantor) return null

  const role = await prisma.role.findUnique({ where: { key: 'guarantor' } })
  if (!role) {
    // Same failure posture as the tenant role above: a guarantor with a
    // silently-guessed permission set is worse than one who cannot sign in.
    throw new Error(
      'The `guarantor` role is missing. Run `npm run db:seed` - roles are data (D-5).',
    )
  }

  const actor: Actor = {
    id: guarantor.id,
    orgId: guarantor.orgId,
    kind: 'guarantor',
    active: guarantor.active,
    // No second factor and nothing on the privileged list, same reasoning
    // as a tenant.
    mfaVerified: false,
    assignments: [
      {
        orgId: guarantor.orgId,
        roleKey: role.key,
        permissions: knownPermissions(role.permissions),
        legalEntityId: null,
        propertyId: null,
      },
    ],
    leaseIds: [guarantor.leaseId],
    ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 },
  }
  return actor
}

/**
 * The signed-in actor, or null. Per-request memoized.
 *
 * Returns null rather than throwing when there is no session, because "not
 * signed in" is an ordinary state that every page handles by redirecting.
 */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const session = await auth()
  if (!session?.principal) return null

  switch (session.principal.kind) {
    case 'staff':
      return loadStaffActor(
        session.principal.id,
        session.principal.mfaVerified,
        session.principal.orgId,
      )
    case 'guarantor':
      return loadGuarantorActor(session.principal.id)
    default:
      return loadTenantActor(session.principal.id)
  }
})
