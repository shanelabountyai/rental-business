// Thread identity and inbound routing (COMM-01, R-017). Pure - the database
// half lives in apps/web/lib/comms.

/// The participant a thread belongs to. Ticket and work-order threads
/// (COMM-06) are R-032's; this is the "per tenancy / per property / per
/// vendor" set the backlog names for this item.
export const THREAD_SCOPES = ['TENANT', 'VENDOR', 'PROPERTY'] as const
export type ThreadScope = (typeof THREAD_SCOPES)[number]

export interface ThreadIdentity {
  scope: ThreadScope
  propertyId: string
  /// Required for TENANT, ignored otherwise.
  tenantId?: string | null
  /// Required for VENDOR, ignored otherwise.
  vendorId?: string | null
  /// VENDOR only, and OPTIONAL - see threadKey's own comment on why a vendor
  /// has two distinct kinds of thread rather than one.
  workOrderId?: string | null
}

/**
 * The deterministic key stored on `Thread.key`.
 *
 * Property is part of every key, including a tenant's. That is deliberate and
 * costs something worth naming: a tenant who moves between two properties in
 * the same portfolio gets two threads rather than one continuous history.
 *
 * The alternative - keying a tenant thread on the tenant alone - leaves
 * `Thread.propertyId` stale the moment they move, and `propertyId` is what
 * every RBAC scope check in this product filters on (R-004). A stale one
 * means a manager scoped to the new property cannot read the conversation
 * they are responsible for, while a manager scoped to the old one still can.
 * Getting authorization wrong is worse than splitting a rare history, so the
 * property stays in the key.
 */
export function threadKey(identity: ThreadIdentity): string {
  switch (identity.scope) {
    case 'TENANT':
      if (!identity.tenantId) {
        throw new Error('A TENANT thread needs a tenantId.')
      }
      return `tenant:${identity.tenantId}:property:${identity.propertyId}`
    case 'VENDOR':
      if (!identity.vendorId) {
        throw new Error('A VENDOR thread needs a vendorId.')
      }
      // TWO KINDS OF VENDOR THREAD, deliberately keyed differently (R-032,
      // COMM-06).
      //
      // With no work order: the property-level relationship inbound SMS
      // routes into (R-021's candidatesForPhone has no way to know which of
      // a vendor's several concurrent jobs a text is about, so it has always
      // resolved to "their most recent work order's property" - unchanged
      // here).
      //
      // With a work order: the per-job conversation D-16 already treats as
      // the natural unit for a vendor - the magic link itself is scoped to
      // exactly one work order, so the thread reachable through it is too.
      // PORTAL-only in practice (see the app layer), which is what keeps
      // this from fragmenting: a vendor's SMS reply would land in the OTHER
      // thread, and offering SMS here would silently split one conversation
      // into two nobody reads together.
      return identity.workOrderId
        ? `vendor:${identity.vendorId}:workorder:${identity.workOrderId}`
        : `vendor:${identity.vendorId}:property:${identity.propertyId}`
    case 'PROPERTY':
      return `property:${identity.propertyId}`
  }
}

/// Why an inbound message could not be filed automatically. Stored on
/// UnroutedMessage.reason.
export const UNROUTED_REASONS = ['UNKNOWN_SENDER', 'AMBIGUOUS'] as const
export type UnroutedReason = (typeof UNROUTED_REASONS)[number]

/// One party whose phone matched an inbound message.
export interface RouteCandidate {
  scope: Extract<ThreadScope, 'TENANT' | 'VENDOR'>
  partyId: string
  propertyId: string
}

export type RouteDecision =
  | { outcome: 'routed'; candidate: RouteCandidate }
  | { outcome: 'unrouted'; reason: UnroutedReason }

/**
 * Whether an inbound message can be filed, given everyone whose number
 * matched it.
 *
 * THE ENTIRE POINT IS THAT IT REFUSES TO GUESS. Exactly one match routes;
 * anything else does not:
 *
 *   Zero matches - a wrong number, a tenant whose phone was never recorded, a
 *   contractor texting from a personal mobile. There is no safe default;
 *   filing it under "probably the tenant at that property" would be inventing
 *   a fact.
 *
 *   More than one match - a couple sharing a phone is completely ordinary,
 *   and so is a handyman who is also a tenant. Picking one files a
 *   conversation into the wrong person's permanent record, and the record
 *   will look authoritative afterwards.
 *
 * A refusal costs somebody thirty seconds of triage. A wrong match is a
 * cross-tenant data leak carrying an audit trail that says it was legitimate.
 * When those are the two failure modes, the tie-break is not close.
 *
 * Note the deliberate absence of a preference order (tenants before vendors,
 * most-recent-lease first, and so on). Every such rule is a rule for
 * resolving an ambiguity the product cannot actually resolve, and each one
 * turns a visible refusal into an invisible mistake.
 */
export function decideRoute(candidates: readonly RouteCandidate[]): RouteDecision {
  if (candidates.length === 0) {
    return { outcome: 'unrouted', reason: 'UNKNOWN_SENDER' }
  }
  if (candidates.length > 1) {
    // One party matched through two rows - the same tenant found twice - is
    // not an ambiguity. Distinct PARTIES are.
    const distinct = new Set(candidates.map((c) => `${c.scope}:${c.partyId}`))
    if (distinct.size > 1) {
      return { outcome: 'unrouted', reason: 'AMBIGUOUS' }
    }
    // Same party, but reachable at more than one property: still ambiguous,
    // because the thread key includes the property and there is no basis for
    // choosing one.
    const properties = new Set(candidates.map((c) => c.propertyId))
    if (properties.size > 1) {
      return { outcome: 'unrouted', reason: 'AMBIGUOUS' }
    }
  }
  return { outcome: 'routed', candidate: candidates[0]! }
}
