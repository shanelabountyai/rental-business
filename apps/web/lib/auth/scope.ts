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
  if (scope.everything) return {}
  if (scopeIsEmpty(scope)) return null

  return {
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
  if (scope.everything) return {}
  if (scopeIsEmpty(scope)) return null

  if (scope.legalEntityIds.length === 0) {
    return { propertyId: { in: scope.propertyIds } }
  }
  return {
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
