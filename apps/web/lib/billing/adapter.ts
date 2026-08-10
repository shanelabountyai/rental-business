import 'server-only'

// The billing provider seam (D-11, D-15's pattern, R-034).
//
// WHY A SEAM RATHER THAN A STRIPE CLIENT. D-11 makes Stripe the source of
// truth for money, and this deployment has no Stripe credentials: the
// multi-LLC KYB underwriting the backlog flags at R-001 has a real lead
// time and has not cleared. D-15 already decided what to do in exactly this
// situation, for Resend and Twilio: "writing an HTTP client that has never
// once been executed - against an account that does not exist - produces
// code that looks finished and is untested, which is strictly worse than an
// honest seam."
//
// So the OUTBOUND half is a seam with a simulator behind it. The INBOUND
// half - signature verification, idempotency, the projection pipeline - is
// built for real and tested exhaustively, because R-021 drew that line and
// it is the right one: a receiver can be exercised completely with synthetic
// requests, and it is the security boundary of a public endpoint.
//
// What the simulator is NOT: a stub that returns fixed strings. It mints
// Stripe-shaped ids AND can emit the webhook events Stripe would emit for
// them, which is what lets the whole inbound pipeline be exercised end to
// end against realistic payloads. A simulator that only minted ids would
// leave the valuable machinery untested.

export interface CustomerInput {
  /// Our own id for the payer, sent to Stripe as metadata so a human looking
  /// at the Stripe dashboard can get back to the lease.
  leasePayerId: string
  leaseId: string
  propertyId: string
  name: string
  email: string | null
  phone: string | null
}

export interface SubscriptionInput {
  stripeCustomerId: string
  /// Integer cents. D-12: core decides the amount, Stripe executes it.
  amountCents: number
  currency: string
  /// The instant computed by `billingCycleAnchor` in property-local time.
  billingCycleAnchor: Date
  leaseId: string
  leasePayerId: string
}

export interface ProvisionedCustomer {
  stripeCustomerId: string
}

export interface ProvisionedSubscription {
  stripeSubscriptionId: string
  stripePriceId: string
}

export interface ProvisionedSetupIntent {
  clientSecret: string
  setupIntentId: string
}

/**
 * Everything this product asks Stripe to DO.
 *
 * Deliberately narrow. R-036 owns the subscription lifecycle (pause, resume,
 * cancel, re-sync), R-037 owns tenant-facing payment, R-040 owns pushing
 * core-computed invoice items. Each will widen this interface when it needs
 * to - a wider one now would be method signatures guessed at ahead of their
 * only caller.
 */
export interface BillingProvider {
  readonly name: string
  createCustomer(input: CustomerInput): Promise<ProvisionedCustomer>
  createSubscription(input: SubscriptionInput): Promise<ProvisionedSubscription>
  /// PAY-02's saved payment method. Stripe-hosted fields only - this returns
  /// a client secret for their Elements to use, and no card or bank number
  /// ever reaches this product (master PRD §6.6).
  createSetupIntent(stripeCustomerId: string): Promise<ProvisionedSetupIntent>
}
