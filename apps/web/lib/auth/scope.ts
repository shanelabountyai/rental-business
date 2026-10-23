import { type PropertyScope, scopeIsEmpty } from '@rental/core/rbac'
import type { Prisma } from '@rental/db'

// Turning a scope into a where clause. Separate from guard.ts, which reads the
// session: these are pure functions of a PropertyScope and touch neither
// Auth.js nor the request, so they can be tested against a real database
// without standing up a session.
//
// This is the ONE place that knows how a scope becomes SQL. A second place
// would eventually disagree with the first, and the disagreement would be
// invisible until the wrong person opened the rent roll.
//
// EVERY fragment below carries `orgId`, including the `everything` case,
// which used to be `{}` (R-285b, PRD 10 §1.3). `everything` means everything
// in ONE organisation. A `{}` here is the cross-org superuser D-339 closed,
// so never return one.

/**
 * A Prisma `where` fragment restricting Property rows to a scope.
 *
 * Returns `null` when the actor may see nothing, and callers MUST treat that
 * as "return no rows" rather than "no filter". That distinction is the whole
 * risk here: `{}` and `null` are one keystroke apart and mean the opposite
 * things, so an empty scope is deliberately not representable as an object
 * that could be spread into a query and silently vanish.
 */
export function propertyWhere(
  scope: PropertyScope,
): Prisma.PropertyWhereInput | null {
  if (scope.everything) return { orgId: scope.orgId }
  if (scopeIsEmpty(scope)) return null

  return {
    orgId: scope.orgId,
    OR: [
      ...(scope.propertyIds.length > 0
        ? [{ id: { in: scope.propertyIds } }]
        : []),
      ...(scope.legalEntityIds.length > 0
        ? [{ legalEntityId: { in: scope.legalEntityIds } }]
        : []),
    ],
  }
}

/**
 * Tenant rows within a scope (SEC-02). `Tenant` is an org root - it carries
 * `orgId` but no property - so a tenant is in scope when they are a party to a lease at a
 * property the actor can see. Every tenant is created onto a lease (import,
 * party change), so none is stranded by this. Same `null` contract as
 * `propertyWhere`.
 */
export function tenantWhere(
  scope: PropertyScope,
): Prisma.TenantWhereInput | null {
  const property = propertyWhere(scope)
  if (property === null) return null
  if (scope.everything) return { orgId: scope.orgId }
  return { orgId: scope.orgId, leaseTenants: { some: { lease: { property } } } }
}

/**
 * The same restriction for any row carrying `propertyId` directly - which is
 * every operational and financial entity, because R-002 denormalized it for
 * exactly this reason (schema.prisma, "Scoping").
 *
 * An entity-scoped grant has to reach through the property relation: there is
 * no `legalEntityId` on a Ticket, and adding one would be a second source of
 * truth for who owns a row.
 */
export function scopedByProperty(
  scope: PropertyScope,
): Prisma.TicketWhereInput | null {
  if (scope.everything) return { orgId: scope.orgId }
  if (scopeIsEmpty(scope)) return null

  if (scope.legalEntityIds.length === 0) {
    return { orgId: scope.orgId, propertyId: { in: scope.propertyIds } }
  }
  return {
    orgId: scope.orgId,
    property: {
      OR: [
        ...(scope.propertyIds.length > 0
          ? [{ id: { in: scope.propertyIds } }]
          : []),
        { legalEntityId: { in: scope.legalEntityIds } },
      ],
    },
  }
}
