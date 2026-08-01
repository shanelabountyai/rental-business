import 'server-only'

import {
  type Actor,
  type MonetaryAction,
  type Permission,
  type PropertyScope,
  type Resource,
  can,
  checkMonetaryAuthority,
  propertyScope,
} from '@rental/core/rbac'
import { redirect } from 'next/navigation'
import { currentActor } from './actor.ts'

// Re-exported so call sites have one import for "authorize this". The
// implementations live in scope.ts, which imports no session machinery and is
// therefore testable against a real database on its own.
export { propertyWhere, scopedByProperty } from './scope.ts'

// ROLE-01: "Authorization enforced server-side per role and record scope, not
// just hidden UI."
//
// Two shapes, and the difference is the whole point:
//
//   requirePermission() answers "may this actor do X to THIS record?" - the
//   check before a write, or before rendering one thing.
//
//   propertyWhere()/scopedByProperty() answer "which records may this actor see?" - the
//   where clause for a list. A list that fetches everything and filters in the
//   template is a data leak with a nice presentation layer, so scoping belongs
//   in the query.
//
// Both go through packages/core. Nothing here decides anything itself.

export class AuthorizationError extends Error {
  constructor(
    readonly permission: Permission,
    readonly reason: string,
  ) {
    super(`Not permitted: ${permission} (${reason})`)
    this.name = 'AuthorizationError'
  }
}

/// The signed-in staff actor, or a redirect to sign-in. Use at the top of any
/// staff page or action.
export async function requireStaff(): Promise<Actor> {
  const actor = await currentActor()
  if (!actor || actor.kind !== 'staff' || !actor.active) redirect('/login')
  return actor
}

export async function requireTenant(): Promise<Actor> {
  const actor = await currentActor()
  if (!actor || actor.kind !== 'tenant' || !actor.active) {
    redirect('/portal/login')
  }
  return actor
}

/**
 * Throws unless the actor may do this to this record.
 *
 * `mfa_required` is special-cased into a redirect rather than an error: the
 * user is allowed to do this, they just have not proved a second factor yet
 * (ROLE-05), and sending them to enrol is the useful response. Every other
 * denial throws, because there is nothing the user can do about it in the
 * moment and pretending otherwise sends them in circles.
 */
export async function requirePermission(
  permission: Permission,
  resource: Resource = {},
): Promise<Actor> {
  const actor = await currentActor()
  if (!actor) redirect('/login')

  const decision = can(actor, permission, resource)
  if (decision.allowed) return actor

  if (decision.reason === 'mfa_required') redirect('/account?mfa=required')
  throw new AuthorizationError(permission, decision.reason)
}

/// Non-throwing variant, for deciding whether to render a control. NEVER the
/// only check in front of a mutation - hiding a button is not authorization.
export async function actorCan(
  permission: Permission,
  resource: Resource = {},
): Promise<boolean> {
  const actor = await currentActor()
  return actor ? can(actor, permission, resource).allowed : false
}

/// Convenience: the scope for a permission the current actor holds.
export async function currentScope(
  permission: Permission,
): Promise<PropertyScope> {
  const actor = await currentActor()
  if (!actor) return { everything: false, legalEntityIds: [], propertyIds: [] }
  return propertyScope(actor, permission)
}

/**
 * ROLE-02 / MAINT-04. Returns the decision rather than throwing, because
 * "over your ceiling" is not a failure - it routes up, and the caller has to
 * create that approval.
 */
export async function requireMonetaryAuthority(
  action: MonetaryAction,
  amountCents: number,
) {
  const actor = await requireStaff()
  return { actor, decision: checkMonetaryAuthority(actor, action, amountCents) }
}
