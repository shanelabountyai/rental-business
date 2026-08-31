import 'server-only'

import { prisma } from '@rental/db'

// Reads for the Staff section (R-138). The directory is portfolio-wide by
// nature - a StaffUser carries no `propertyId` - so there is no scope to
// narrow these by, which is the same posture `Vendor` and `JurisdictionRule`
// already take. The page guards `staff.read` resource-lessly and the nav
// marks it `portfolioOnly` for exactly that reason.

const ASSIGNMENT_INCLUDE = {
  role: { select: { key: true, name: true } },
  property: { select: { id: true, name: true } },
  legalEntity: { select: { id: true, name: true } },
} as const

/**
 * The directory. ACTIVE STAFF ONLY unless asked otherwise.
 *
 * Deactivation preserves the row for ever (ROLE-06), so this list grows with
 * every leaver the business ever had and never shrinks - a directory whose
 * first screenful is last year's leavers is a directory nobody opens. It is
 * not only cosmetic: rendering every row unbounded is what made this page
 * time out an axe scan against a database holding 10,449 of them, which is a
 * shape a long-lived deployment reaches on its own.
 *
 * No pagination beyond that. This product is 10-50 units with an
 * owner-operator and a small team (PRD §1); a page size for a list that
 * realistically holds five people would be machinery with nothing to do.
 * ponytail: unpaginated, add a page size if a real deployment passes ~200.
 */
export async function listStaff({ includeInactive = false } = {}) {
  return prisma.staffUser.findMany({
    where: includeInactive ? {} : { active: true },
    include: {
      assignments: {
        where: { revokedAt: null },
        include: ASSIGNMENT_INCLUDE,
        orderBy: { grantedAt: 'asc' },
      },
    },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })
}

/**
 * One staff member and their whole grant history - revoked rows included.
 *
 * The revoked ones are shown rather than filtered because they are the
 * evidence that the access existed (ROLE-06), and "when did we take this
 * away" is the question asked after an incident, not before one.
 */
export async function staffDetail(id: string) {
  return prisma.staffUser.findUnique({
    where: { id },
    include: {
      credential: { select: { mfaEnrolledAt: true, passwordUpdatedAt: true } },
      assignments: {
        include: { ...ASSIGNMENT_INCLUDE, grantedBy: { select: { name: true } } },
        orderBy: [{ revokedAt: 'asc' }, { grantedAt: 'desc' }],
      },
    },
  })
}

/// Every assignment in the deployment, in the shape `rules.ts` reasons over.
/// The lockout rules are about the deployment as a whole - "is this the last
/// owner" cannot be answered from one staff member's rows.
export async function allAssignmentSummaries() {
  const rows = await prisma.staffAssignment.findMany({
    select: { id: true, staffUserId: true, revokedAt: true, role: { select: { key: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    staffUserId: row.staffUserId,
    roleKey: row.role.key,
    revokedAt: row.revokedAt,
  }))
}

/// Scope choices for a grant. Both lists are unscoped on purpose: only an
/// actor holding portfolio-wide `staff.manage` reaches this form at all, and
/// a grant they cannot see the target of is a grant they cannot make.
export async function grantScopeOptions() {
  const [properties, legalEntities] = await Promise.all([
    prisma.property.findMany({
      where: { active: true },
      select: { id: true, name: true, legalEntity: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.legalEntity.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])
  return { properties, legalEntities }
}
