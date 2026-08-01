import { type Permission, requiresMfa } from './permissions.ts'

// can() and propertyScope() - the two functions D-5 names and forbids putting
// a bypass in.
//
// Both are pure. The app layer loads the actor from the database once per
// request and hands it here; nothing in this file knows what Prisma is, which
// is what makes the whole decision table testable without standing up a
// database and is why the tests below it can be exhaustive.
//
// THE RULE, restated because it is the one that matters: there is no
// superuser. An owner is an actor holding an assignment whose role carries
// every permission and whose scope is null. Read the code below and you will
// find no branch on a name, a flag, or an id - only "does some assignment
// grant this permission over this resource".

/// One grant, already resolved from the database. `propertyId` and
/// `legalEntityId` both null means portfolio-wide (D-5).
export interface Assignment {
  roleKey: string
  permissions: readonly Permission[]
  legalEntityId: string | null
  propertyId: string | null
}

export interface Actor {
  id: string
  kind: 'staff' | 'tenant' | 'guarantor' | 'vendor' | 'system'
  /// A deactivated actor can do nothing, whatever their assignments say
  /// (ROLE-06).
  active: boolean
  /// Whether a second factor was proved during this sign-in (R-003). Gates
  /// privileged permissions only.
  mfaVerified: boolean
  assignments: readonly Assignment[]
  /// Tenant and guarantor actors are scoped to their own leases rather than to
  /// properties. Empty for staff.
  leaseIds: readonly string[]
  ceilings: {
    approveWorkOrderCents: number | null
    waiveFeeCents: number | null
  }
}

/// What is being acted on. Omitting both means "does this actor hold this
/// permission anywhere at all" - useful for deciding whether to show a nav
/// item, never sufficient for authorizing a write.
export interface Resource {
  propertyId?: string | null
  legalEntityId?: string | null
  leaseId?: string | null
}

export type Denial =
  | 'inactive'
  | 'no_permission'
  | 'out_of_scope'
  | 'mfa_required'

export type Decision = { allowed: true } | { allowed: false; reason: Denial }

const ALLOWED: Decision = { allowed: true }

/**
 * The authorization decision. Deny by default: every path that is not an
 * explicit grant returns false.
 *
 * Order is deliberate. Inactive first, because a deactivated user must fail
 * identically no matter what they ask for. Then the permission itself, then
 * scope, then MFA - so a user who lacks a permission entirely is told
 * "no_permission" rather than being sent to set up an authenticator app that
 * would not have helped.
 */
export function can(
  actor: Actor,
  permission: Permission,
  resource: Resource = {},
): Decision {
  if (!actor.active) return { allowed: false, reason: 'inactive' }

  const granting = actor.assignments.filter((assignment) =>
    assignment.permissions.includes(permission),
  )
  if (granting.length === 0) {
    return { allowed: false, reason: 'no_permission' }
  }

  const inScope = granting.some((assignment) =>
    assignmentCovers(actor, assignment, resource),
  )
  if (!inScope) return { allowed: false, reason: 'out_of_scope' }

  // ROLE-05. Checked last so it only ever blocks someone who would otherwise
  // have been allowed - which makes "enrol in MFA to continue" the honest
  // message rather than a red herring.
  if (requiresMfa(permission) && !actor.mfaVerified) {
    return { allowed: false, reason: 'mfa_required' }
  }

  return ALLOWED
}

/// Convenience for call sites that only branch on yes/no.
export function allowed(
  actor: Actor,
  permission: Permission,
  resource: Resource = {},
): boolean {
  return can(actor, permission, resource).allowed
}

function assignmentCovers(
  actor: Actor,
  assignment: Assignment,
  resource: Resource,
): boolean {
  // Tenants and guarantors are scoped to their own leases. A tenant has no
  // property-level access at all, even to the property their home sits on -
  // "own lease/tickets/docs/payments only" (ROLE-01).
  if (actor.kind === 'tenant' || actor.kind === 'guarantor') {
    if (!resource.leaseId) return false
    return actor.leaseIds.includes(resource.leaseId)
  }

  // Portfolio-wide: both scope columns null. This is the owner, and it is an
  // ordinary row rather than a flag.
  if (assignment.propertyId === null && assignment.legalEntityId === null) {
    return true
  }

  if (assignment.propertyId !== null) {
    return resource.propertyId === assignment.propertyId
  }

  return resource.legalEntityId === assignment.legalEntityId
}

/**
 * The set of properties an actor may exercise a permission over, as a
 * descriptor the database layer turns into a where clause. Returned rather
 * than applied here so this stays pure and so there is exactly one place that
 * knows how a scope becomes SQL.
 *
 * `everything: true` is portfolio-wide access. It is NOT a bypass: it is the
 * honest answer for an assignment with a null scope, and the caller still has
 * to have passed a permission check to get here.
 */
export type PropertyScope =
  | { everything: true }
  | { everything: false; legalEntityIds: string[]; propertyIds: string[] }

/// Denies everything. Named so the intent is obvious at call sites.
export const SCOPE_NONE: PropertyScope = {
  everything: false,
  legalEntityIds: [],
  propertyIds: [],
}

export function propertyScope(
  actor: Actor,
  permission: Permission,
): PropertyScope {
  if (!actor.active) return SCOPE_NONE
  // A tenant's world is their leases, not a set of properties. Callers
  // filtering properties for a tenant get nothing, which is correct - the
  // tenant portal queries by lease.
  if (actor.kind === 'tenant' || actor.kind === 'guarantor') return SCOPE_NONE
  if (requiresMfa(permission) && !actor.mfaVerified) return SCOPE_NONE

  const granting = actor.assignments.filter((assignment) =>
    assignment.permissions.includes(permission),
  )
  if (granting.some((a) => a.propertyId === null && a.legalEntityId === null)) {
    return { everything: true }
  }

  const legalEntityIds = new Set<string>()
  const propertyIds = new Set<string>()
  for (const assignment of granting) {
    if (assignment.propertyId !== null) propertyIds.add(assignment.propertyId)
    else if (assignment.legalEntityId !== null) {
      legalEntityIds.add(assignment.legalEntityId)
    }
  }

  return {
    everything: false,
    legalEntityIds: [...legalEntityIds],
    propertyIds: [...propertyIds],
  }
}

/// True when a scope can never match anything, so callers can skip the query
/// rather than issuing one that is guaranteed to return nothing.
export function scopeIsEmpty(scope: PropertyScope): boolean {
  return (
    !scope.everything &&
    scope.legalEntityIds.length === 0 &&
    scope.propertyIds.length === 0
  )
}
