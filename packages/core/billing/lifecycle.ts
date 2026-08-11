// The subscription lifecycle (PAY-03, D-11, R-036). Pure - no database, no
// SDK, no HTTP.
//
// The backlog calls R-036 "the item where D-11 actually pays off", and the
// reason is this file's shortness: under D-2's ledger-driven design, "the
// tenancy ended, stop billing" meant a scheduler, a calendar, a retry
// policy and a reconciliation. Under D-11 it is one decision function and
// one API call.
//
// THIS MODULE DECIDES; IT DOES NOT ACT. Given what a lease looks like now
// and what Stripe currently believes, it says what should happen. The app
// layer performs it. That split is what lets every branch be tested without
// a Stripe account, and it is where the branches that matter live: billing
// a tenant who moved out, and NOT billing one who did not.

export type LifecycleAction =
  /// Nothing to do - Stripe already agrees.
  | 'none'
  /// The lease has no subscription yet and should have one.
  | 'provision'
  /// The rent changed.
  | 'update_price'
  /// Collection should stop but the tenancy has not ended - a legal-action
  /// hold (PAY-12), or an owner pausing deliberately.
  | 'pause'
  | 'resume'
  /// The tenancy is over.
  | 'cancel'

export interface LeaseBillingFacts {
  status: string
  rentCents: number
  /// Null until provisioned.
  stripeSubscriptionId: string | null
  /// True while the lease is under a collection hold. R-047 owns the
  /// per-tenant switches that set it; this only reacts to it.
  collectionPaused: boolean
  /// When the tenancy actually ends, for a cancellation that should take
  /// effect then rather than immediately.
  moveOutAt: Date | null
}

/// What Stripe currently believes. Null when nothing has been fetched -
/// which is not the same as "Stripe has nothing", and is why the decision
/// distinguishes them.
export interface StripeSubscriptionFacts {
  status: string
  amountCents: number | null
  cancelAt: Date | null
}

export interface LifecycleDecision {
  action: LifecycleAction
  /// Why, in a sentence, for the Billing Runs screen and the audit entry.
  reason: string
  /// For `cancel`, when it should take effect. Absent means immediately.
  effectiveAt?: Date
}

/// Stripe statuses that mean the subscription is no longer billing.
const STRIPE_TERMINAL: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired'])

/// Lease statuses that mean the tenancy is running and rent is owed. Kept in
/// step with `leaseIsInForce` in packages/core/leases - duplicated
/// deliberately rather than imported, because billing must not start
/// depending on the lease module's own evolution.
const LEASE_IN_FORCE: ReadonlySet<string> = new Set(['ACTIVE', 'MONTH_TO_MONTH'])

/**
 * What should happen to this lease's subscription.
 *
 * ORDER MATTERS. "The tenancy is over" outranks everything: a lease that has
 * ended must stop billing even if the rent also changed on the way out, and
 * checking the rent first would update the price on a subscription that
 * should be cancelled - billing somebody who has moved out, at a new rate.
 */
export function lifecycleDecision(
  lease: LeaseBillingFacts,
  stripe: StripeSubscriptionFacts | null,
): LifecycleDecision {
  const inForce = LEASE_IN_FORCE.has(lease.status)

  // 1. The tenancy is over.
  if (!inForce && lease.status !== 'DRAFT' && lease.status !== 'PENDING_SIGNATURE') {
    if (!lease.stripeSubscriptionId) {
      return { action: 'none', reason: 'The tenancy is over and never had a subscription.' }
    }
    if (stripe && STRIPE_TERMINAL.has(stripe.status)) {
      return { action: 'none', reason: 'Already cancelled at Stripe.' }
    }
    if (stripe?.cancelAt) {
      return {
        action: 'none',
        reason: `Already scheduled to cancel on ${stripe.cancelAt.toISOString().slice(0, 10)}.`,
      }
    }
    return {
      action: 'cancel',
      reason: 'The tenancy has ended, so billing must stop.',
      // The move-out date if there is one - a tenancy ending on the last day
      // of a month should bill that month, not be cut off mid-period.
      ...(lease.moveOutAt ? { effectiveAt: lease.moveOutAt } : {}),
    }
  }

  // 2. Not live yet.
  if (!inForce) {
    return {
      action: 'none',
      reason: 'The lease is not live yet - billing opens when it activates.',
    }
  }

  // 3. Live, but nothing at Stripe.
  if (!lease.stripeSubscriptionId) {
    return { action: 'provision', reason: 'A live tenancy with no subscription.' }
  }

  // A live lease whose Stripe subscription has been cancelled behind our
  // back. Reported rather than silently re-provisioned: re-creating one
  // would start billing again on an anchor nobody chose, and somebody
  // cancelled it for a reason worth asking about.
  if (stripe && STRIPE_TERMINAL.has(stripe.status)) {
    return {
      action: 'provision',
      reason:
        'The tenancy is live but its Stripe subscription is cancelled - it needs re-provisioning.',
    }
  }

  // 4. Collection hold.
  const stripePaused = stripe?.status === 'paused'
  if (lease.collectionPaused && !stripePaused) {
    return { action: 'pause', reason: 'The lease is under a collection hold.' }
  }
  if (!lease.collectionPaused && stripePaused) {
    return { action: 'resume', reason: 'The collection hold has been lifted.' }
  }

  // 5. The rent changed. Last, so it can never be applied to a subscription
  // that should have been cancelled.
  if (stripe && stripe.amountCents != null && stripe.amountCents !== lease.rentCents) {
    return {
      action: 'update_price',
      reason: `Rent is ${lease.rentCents}c but Stripe is billing ${stripe.amountCents}c.`,
    }
  }

  return { action: 'none', reason: 'Stripe agrees with the lease.' }
}

/// Whether a decision changes anything at Stripe. Kept beside the decision
/// so a caller cannot forget that `none` means "make no call" rather than
/// "make a call that happens to be a no-op" - the second would burn an API
/// round trip per lease per sweep.
export function requiresStripeCall(decision: LifecycleDecision): boolean {
  return decision.action !== 'none'
}
