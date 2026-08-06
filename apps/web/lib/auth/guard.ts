import 'server-only'

import {
  type Actor,
  type Decision,
  type MonetaryAction,
  type Permission,
  type PropertyScope,
  type Resource,
  can,
  checkMonetaryAuthority,
  propertyScope,
  scopeIsEmpty,
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

/// Retained for callers that need a hard failure rather than a redirect - an
/// API route answering a machine, for instance. Page and action guards below
/// redirect instead; see requirePermission.
export class AuthorizationError extends Error {
  // Explicit fields rather than constructor parameter properties, matching
  // packages/core. Next compiles this file properly so it would work either
  // way, but keeping one rule across the repo is cheaper than remembering
  // which files are reachable from a CLI script.
  readonly permission: Permission
  readonly reason: string

  constructor(permission: Permission, reason: string) {
    super(`Not permitted: ${permission} (${reason})`)
    this.name = 'AuthorizationError'
    this.permission = permission
    this.reason = reason
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

  // Every denial is a redirect to somewhere that explains itself, because
  // none of them is a fault. Throwing produced Next's "This page couldn't
  // load" crash page for the entirely ordinary case of a maintenance tech
  // opening a financial link.
  //
  // mfa_required goes to enrolment because the user IS allowed and only needs
  // to prove a second factor (ROLE-05). The rest go to /no-access, which says
  // which permission was missing.
  if (decision.reason === 'mfa_required') redirect('/account?mfa=required')
  redirect(
    `/no-access?permission=${encodeURIComponent(permission)}&reason=${decision.reason}`,
  )
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

/**
 * The same check, but keeping WHY - for the handful of screens where the
 * difference changes what to say.
 *
 * `actorCan()` collapses every denial into `false`, which is right for
 * "should this button exist" and WRONG the moment a screen wants to explain
 * itself: an owner who holds `workorder.approve` but has not verified MFA
 * (ROLE-05 gates every privileged permission behind it) is not lacking
 * authority, they are one step away from using it. Telling them "waiting on
 * somebody with approval authority" is a dead end for the one person who
 * can actually act. R-026 found this on the approval panel.
 *
 * Returns `no_permission` for a signed-out caller, since from a rendering
 * decision's point of view they are equally unable.
 */
export async function actorDecision(
  permission: Permission,
  resource: Resource = {},
): Promise<Decision> {
  const actor = await currentActor()
  if (!actor) return { allowed: false, reason: 'no_permission' }
  return can(actor, permission, resource)
}

/**
 * The full resource for a check against an EXISTING property (or anything
 * scoped through one - a unit, a ticket, a work order). Pass both ids, not
 * just `propertyId`.
 *
 * A record found while diagnosing R-009: `can()`'s `assignmentCovers` picks
 * ONE branch per assignment - a property-scoped grant is checked against
 * `resource.propertyId`, an entity-scoped grant against
 * `resource.legalEntityId` - and it never falls back from one to the other.
 * `requirePermission('property.write', { propertyId })` therefore denies an
 * entity-scoped manager editing a property that genuinely belongs to their
 * own entity, because `resource.legalEntityId` was never supplied for
 * `assignmentCovers` to check against. This shipped in R-008 on the property
 * edit page, its guard, and its Edit-button visibility check - all three
 * fixed alongside this helper, which exists so the next item scoping through
 * a property does not have to rediscover the same gap.
 */
export function propertyResource(property: {
  id: string
  legalEntityId: string
}): Resource {
  return { propertyId: property.id, legalEntityId: property.legalEntityId }
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
 * The guard for a SCOPED LIST or SUMMARY page - "Properties", a rent roll, a
 * ticket queue - as opposed to `requirePermission()`, which answers "may this
 * actor act on THIS one record".
 *
 * A resource-less `requirePermission(permission)` looks like the right guard
 * for a list page and is NOT: per `can()`'s `assignmentCovers`, an empty
 * resource only ever matches a portfolio-wide grant, so it wrongly sends an
 * entity- or property-scoped actor to /no-access even though a scoped query
 * would show them a perfectly real, non-empty list. That bug shipped
 * dormant in R-007's section placeholders - every guard there was
 * `requirePermission('x.read')` with no resource - and stayed hidden because
 * R-007's own tests only ever exercised portfolio-wide roles. R-008's more
 * pointed scoping tests caught it on the Properties list and detail pages.
 *
 * The correct question for a list is "does this actor hold `permission` over
 * ANYTHING at all" - which is exactly what an empty `PropertyScope` means -
 * and then let the scoped query (`propertyWhere`/`scopedByProperty`, or the
 * switcher's own resolved scope) decide what shows up, down to zero rows.
 */
export async function requireScope(
  permission: Permission,
): Promise<{ actor: Actor; scope: PropertyScope }> {
  const actor = await requireStaff()
  const scope = propertyScope(actor, permission)
  if (scopeIsEmpty(scope)) {
    redirect(
      `/no-access?permission=${encodeURIComponent(permission)}&reason=no_permission`,
    )
  }
  return { actor, scope }
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
