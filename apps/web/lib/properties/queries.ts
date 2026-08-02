import 'server-only'

import { type Actor, propertyScope } from '@rental/core/rbac'
import { prisma } from '@rental/db'
// From scope.ts directly, not guard.ts - guard.ts pulls in auth.ts (Auth.js),
// which cannot load outside a request context and breaks this module under
// Vitest. scope.ts is pure Prisma-shaping and has no session dependency; see
// apps/web/lib/auth/scoping.test.ts, which hit the same thing in R-004.
import { propertyWhere } from '@/lib/auth/scope.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Read queries for the Properties section. Every list is scoped - never
// "fetch everything and filter in the template" (ROLE-01).

/// The list and summary view use the SWITCHER's resolved scope
/// (lib/scope/current-scope.ts), so the header control the user just picked
/// actually narrows what they see here - that connection is the point of
/// building the switcher in R-007.
export async function listProperties(scope: ResolvedScope) {
  if (scope.propertyIds.length === 0) return []
  return prisma.property.findMany({
    where: { id: { in: scope.propertyIds } },
    include: { legalEntity: { select: { id: true, name: true } } },
    orderBy: { name: 'asc' },
  })
}

export async function getPropertyDetail(id: string, scope: ResolvedScope) {
  if (!scope.propertyIds.includes(id)) return null
  return prisma.property.findUnique({
    where: { id },
    include: { legalEntity: { select: { id: true, name: true } } },
  })
}

/**
 * Legal entities the actor may create a NEW property under.
 *
 * Deliberately the RBAC write scope (`property.write`), not the switcher's
 * read scope: a property-scoped manager can browse in "their" entity via the
 * switcher but per R-004's scoping rules cannot create a property (there is
 * no `propertyId` yet for a create-time check to match). Only a portfolio-wide
 * or entity-scoped `property.write` grant clears that bar, so an empty result
 * here is a real, expected outcome for a narrowly-scoped user - the create
 * page says so rather than showing an empty, unexplained dropdown.
 */
export async function listWritableLegalEntities(actor: Actor) {
  const scope = propertyScope(actor, 'property.write')
  if (scope.everything) {
    return prisma.legalEntity.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    })
  }
  if (scope.legalEntityIds.length === 0) return []
  return prisma.legalEntity.findMany({
    where: { active: true, id: { in: scope.legalEntityIds } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
}

/**
 * Whether the actor may create a property under SOME entity - no database
 * call, just the same scope filtering `listWritableLegalEntities` uses. For
 * deciding whether to show the "New property" button/page at all; the actual
 * list of entities still requires the query above.
 *
 * Deliberately distinct from a bare `can(actor, 'property.write')` check:
 * that only ever passes for a portfolio-wide grant (an empty resource cannot
 * match an entity- or property-scoped assignment - see
 * packages/core/rbac/can.ts's `assignmentCovers`), which would wrongly hide
 * property creation from an entity-scoped manager who genuinely has it.
 */
export function canCreateAnyProperty(actor: Actor): boolean {
  const scope = propertyScope(actor, 'property.write')
  return scope.everything || scope.legalEntityIds.length > 0
}

/**
 * Every other active property visible to this actor, for the duplicate-address
 * check on create. Scoped to what the actor can already SEE
 * (`property.read`), never the whole portfolio - a check that reached outside
 * an actor's own scope would leak the existence of properties they have no
 * access to ("a property near this address already exists" for an address
 * they are not supposed to know about).
 */
export async function candidateDuplicateProperties(actor: Actor) {
  const scope = propertyScope(actor, 'property.read')
  const where = propertyWhere(scope)
  if (where === null) return []
  return prisma.property.findMany({
    where: { ...where, active: true },
    select: { id: true, name: true, addressLine1: true, postalCode: true },
  })
}
