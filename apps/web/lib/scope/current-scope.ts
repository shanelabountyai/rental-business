import 'server-only'

import { type Actor, propertyScope } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { cookies } from 'next/headers'
import { cache } from 'react'

// The property switcher's server half.
//
// The switcher is a filter, never a grant. Whatever the cookie says, the
// selection is intersected with what R-004 says the actor may see - so a
// cookie left over from before an assignment was revoked narrows the view and
// can never widen it. That is the only security property this file has, and
// it is the reason the selection is resolved server-side on every request
// rather than trusted from the client.

import type { ResolvedScope, ScopeSelection } from './types.ts'

export type { ResolvedScope, ScopeSelection }

export const SCOPE_COOKIE = 'rental_scope'

function parseCookie(raw: string | undefined): ScopeSelection {
  if (!raw || raw === 'all') return { kind: 'all' }
  const [kind, id] = raw.split(':')
  if (kind === 'entity' && id) return { kind: 'entity', legalEntityId: id }
  if (kind === 'property' && id) return { kind: 'property', propertyId: id }
  return { kind: 'all' }
}

/**
 * Resolves what the actor is currently looking at.
 *
 * Memoized per request, because the layout renders the switcher and the page
 * below it runs scoped queries - both need this and neither should pay for it
 * twice.
 */
export const currentScope = cache(
  async (actor: Actor): Promise<ResolvedScope> => {
    const scope = propertyScope(actor, 'property.read')

    const properties = await prisma.property.findMany({
      where: {
        active: true,
        ...(scope.everything
          ? {}
          : {
              OR: [
                { id: { in: scope.propertyIds } },
                { legalEntityId: { in: scope.legalEntityIds } },
              ],
            }),
      },
      select: { id: true, name: true, legalEntityId: true, timezone: true },
      orderBy: { name: 'asc' },
    })

    const entityIds = [...new Set(properties.map((p) => p.legalEntityId))]
    const entities = await prisma.legalEntity.findMany({
      where: { id: { in: entityIds } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })

    const cookieStore = await cookies()
    const requested = parseCookie(cookieStore.get(SCOPE_COOKIE)?.value)

    // The intersection. A selection naming something outside the actor's
    // reach - revoked since, or simply invented - falls back to "all", which
    // is "all of what THEY can see", not all of the portfolio.
    let selection: ScopeSelection = { kind: 'all' }
    if (
      requested.kind === 'property' &&
      properties.some((p) => p.id === requested.propertyId)
    ) {
      selection = requested
    } else if (
      requested.kind === 'entity' &&
      entities.some((e) => e.id === requested.legalEntityId)
    ) {
      selection = requested
    }

    const propertyIds =
      selection.kind === 'property'
        ? [selection.propertyId]
        : selection.kind === 'entity'
          ? properties
              .filter((p) => p.legalEntityId === selection.legalEntityId)
              .map((p) => p.id)
          : properties.map((p) => p.id)

    return {
      selection,
      availableEntities: entities,
      availableProperties: properties,
      propertyIds,
      switchable: properties.length > 1,
    }
  },
)
