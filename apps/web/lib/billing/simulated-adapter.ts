import 'server-only'

import { randomBytes } from 'node:crypto'
import { prisma } from '@rental/db'
import { leaseBalanceCents } from '@/lib/ledger/queries.ts'
import type { CollectionMethod, PaymentRail } from '@rental/core/payments'
import type {
  BillingProvider,
  CustomerInput,
  PauseBehaviour,
  ProvisionedCustomer,
  ProvisionedSetupIntent,
  ProvisionedSubscription,
  SubscriptionInput,
  SubscriptionRef,
} from './adapter.ts'

// The simulated billing provider (D-7's simulated-adapter convention, R-034).
//
// Mints ids in Stripe's own shape - `cus_`, `sub_`, `price_`, `seti_`, plus
// the `_secret_` suffix a SetupIntent client secret carries - so that every
// column, index, log line and screen downstream is exercised against
// realistic values. An id shaped like `sim-1` would let a length assumption
// or a prefix check pass here and fail the day real ones arrive.
//
// LOUD ABOUT WHAT IT IS. It logs every call, and `name` says `simulated` so
// any screen or log showing the provider says so too. A simulator nobody can
// tell apart from the real thing is how a staging environment gets mistaken
// for production.
//
// IT HOLDS NO STATE OF ITS OWN, and R-036's lifecycle methods are where that
// rule earns its keep. A simulator with an in-memory registry of "paused"
// subscriptions would answer a different question than production does, and
// would forget everything on restart - so `getSubscription` reads OUR OWN
// row instead, which is the same row the re-sync screen compares against.
// The honest consequence is that against the simulator a re-sync can never
// find drift, because both sides are the same record; that is stated on the
// screen rather than left to look like a clean bill of health.

function stripeId(prefix: string): string {
  // 24 base36-ish characters, matching the shape of a real Stripe id closely
  // enough that nothing downstream can depend on the difference.
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

export class SimulatedBillingProvider implements BillingProvider {
  readonly name = 'simulated'

  async createCustomer(input: CustomerInput): Promise<ProvisionedCustomer> {
    const stripeCustomerId = stripeId('cus')
    console.info(
      `[billing:simulated] customer ${stripeCustomerId} for payer ${input.leasePayerId} (${input.name})`,
    )
    return { stripeCustomerId }
  }

  async createSubscription(input: SubscriptionInput): Promise<ProvisionedSubscription> {
    const stripePriceId = stripeId('price')
    const stripeSubscriptionId = stripeId('sub')
    console.info(
      `[billing:simulated] subscription ${stripeSubscriptionId} at ${input.amountCents}c ` +
        `anchored ${input.billingCycleAnchor.toISOString()} for payer ${input.leasePayerId}`,
    )
    return { stripeSubscriptionId, stripePriceId }
  }

  async createSetupIntent(stripeCustomerId: string): Promise<ProvisionedSetupIntent> {
    const setupIntentId = stripeId('seti')
    console.info(`[billing:simulated] setup intent ${setupIntentId} for ${stripeCustomerId}`)
    return {
      setupIntentId,
      clientSecret: `${setupIntentId}_secret_${randomBytes(8).toString('hex')}`,
    }
  }

  async setDefaultPaymentMethod(input: {
    stripeCustomerId: string
    stripePaymentMethodId: string
    stripeSubscriptionId?: string | null
  }): Promise<void> {
    console.info(
      `[billing:simulated] default payment method ${input.stripePaymentMethodId} ` +
        `for ${input.stripeCustomerId}` +
        (input.stripeSubscriptionId ? ` and ${input.stripeSubscriptionId}` : ''),
    )
  }

  async setBillingAnchor(input: {
    stripeSubscriptionId: string
    anchor: Date
  }): Promise<void> {
    console.info(
      `[billing:simulated] anchor for ${input.stripeSubscriptionId} -> ${input.anchor.toISOString()}`,
    )
  }

  async updateSubscriptionPrice(input: {
    stripeSubscriptionId: string
    amountCents: number
    currency: string
    leaseId: string
  }): Promise<{ stripePriceId: string }> {
    const stripePriceId = stripeId('price')
    console.info(
      `[billing:simulated] ${input.stripeSubscriptionId} -> ${input.amountCents}c ` +
        `(price ${stripePriceId}, no proration)`,
    )
    return { stripePriceId }
  }

  async pauseSubscription(input: {
    stripeSubscriptionId: string
    behaviour: PauseBehaviour
  }): Promise<void> {
    console.info(
      `[billing:simulated] paused ${input.stripeSubscriptionId} (${input.behaviour})`,
    )
  }

  async resumeSubscription(input: SubscriptionRef): Promise<void> {
    console.info(`[billing:simulated] resumed ${input.stripeSubscriptionId}`)
  }

  async cancelSubscription(input: SubscriptionRef & { at?: Date }): Promise<void> {
    console.info(
      `[billing:simulated] cancelled ${input.stripeSubscriptionId}` +
        (input.at ? ` at ${input.at.toISOString()}` : ' immediately'),
    )
  }

  /**
   * Reports what this simulator was last TOLD, not what the lease now says.
   *
   * The distinction is the difference between a useful simulator and a
   * useless one. Reading `lease.rentCents` here would make the simulator
   * agree with the lease by construction - so a rent change could never be
   * detected, and the entire `update_price` path would be dead code that
   * only ever ran against real Stripe. Reading `stripeAmountCents` - our
   * record of the last instruction we successfully pushed - reproduces the
   * one behaviour that matters: Stripe remembers what it was told, and
   * disagrees when we have not told it something.
   *
   * Still no in-memory state, for the reason in this file's header: it
   * reads a durable column, so it answers the same after a restart.
   */
  async getSubscription(input: SubscriptionRef) {
    const payer = await prisma.leasePayer.findFirst({
      where: { stripeSubscriptionId: input.stripeSubscriptionId },
      select: {
        stripeAmountCents: true,
        lastSyncAction: true,
        lease: { select: { status: true } },
      },
    })
    if (!payer) return null
    const over = payer.lease.status === 'ENDED' || payer.lease.status === 'TERMINATED'

    // PAUSED IS ANSWERED FROM WHAT THE SIMULATOR WAS TOLD, NOT FROM THE
    // INTENT THAT WOULD TELL IT (D-27, R-047).
    //
    // `lastSyncAction` records what was actually pushed and is written only
    // after the provider accepted the call. Reading `collectionPaused` here
    // instead - which this used to select and then ignore - would answer
    // from the same column `lifecycleDecision` compares against, making
    // BOTH the pause and the resume branches unreachable: the two sides
    // would agree by construction and no test could ever reach a mismatch.
    //
    // Ignoring it entirely, which is what it did before, was worse in one
    // specific direction: `stripePaused` was permanently false, so `pause`
    // fired every sweep (harmless) and `resume` could never fire at all -
    // LIFTING a hold silently left the subscription paused against the
    // simulator, and nothing failed to say so.
    const paused = payer.lastSyncAction === 'paused'

    return {
      // Deliberately reports what a real cancelled subscription would only
      // report AFTER we cancelled it - so a sweep that has not run yet still
      // sees `active` and decides to cancel.
      status: over && payer.stripeAmountCents === null ? 'canceled' : paused ? 'paused' : 'active',
      amountCents: payer.stripeAmountCents,
      cancelAt: null,
    }
  }

  // ---- Tenant payments (R-037, D-29) ----

  async setCollectionMethod(
    input: SubscriptionRef & { collectionMethod: CollectionMethod },
  ): Promise<void> {
    console.info(
      `[billing:simulated] ${input.stripeSubscriptionId} collection -> ${input.collectionMethod}`,
    )
  }

  /**
   * What a simulated Stripe would say is still owed.
   *
   * Answers from the LEDGER rather than from the payer row the switch is
   * about (D-27): the decision must be able to see a balance that our own
   * intent knows nothing about, or the `open_invoice` refusal is dead code
   * no test can reach.
   *
   * Deliberately MORE conservative than real Stripe. A Stripe invoice is
   * open only once issued, while this counts every unpaid charge on the
   * lease - so the simulator refuses a switch in cases the real driver would
   * allow. That direction is the safe one for a decision whose failure mode
   * is billing a tenant twice, and it is stated here rather than discovered
   * later by somebody wondering why test and production disagree.
   */
  async getOpenInvoiceAmountCents(input: SubscriptionRef): Promise<number | null> {
    const payer = await prisma.leasePayer.findFirst({
      where: { stripeSubscriptionId: input.stripeSubscriptionId },
      select: { leaseId: true },
    })
    if (!payer) return null
    return leaseBalanceCents(payer.leaseId)
  }

  async addInvoiceItem(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    description: string
    chargeId?: string
    idempotencyKey: string
  }): Promise<{ stripeInvoiceItemId: string }> {
    const stripeInvoiceItemId = stripeId('ii')
    console.info(
      `[billing:simulated] invoice item ${stripeInvoiceItemId} for ${input.amountCents}c ` +
        `on ${input.stripeCustomerId} - ${input.description} (key ${input.idempotencyKey})`,
    )
    return { stripeInvoiceItemId }
  }

  async addSubscriptionItem(input: {
    stripeSubscriptionId: string
    amountCents: number
    currency: string
    description: string
    recurringChargeId: string
    leaseId: string
    idempotencyKey: string
  }): Promise<{ stripePriceId: string; stripeSubscriptionItemId: string }> {
    const stripePriceId = stripeId('price')
    const stripeSubscriptionItemId = stripeId('si')
    console.info(
      `[billing:simulated] subscription item ${stripeSubscriptionItemId} at ${input.amountCents}c/month ` +
        `on ${input.stripeSubscriptionId} - ${input.description} (key ${input.idempotencyKey})`,
    )
    return { stripePriceId, stripeSubscriptionItemId }
  }

  async endSubscriptionItem(input: { stripeSubscriptionItemId: string }): Promise<void> {
    console.info(`[billing:simulated] subscription item ${input.stripeSubscriptionItemId} ended`)
  }

  async markInvoicePaidOutOfBand(input: {
    stripeInvoiceId: string
    reference: string
  }): Promise<void> {
    console.info(
      `[billing:simulated] invoice ${input.stripeInvoiceId} marked paid out of band (${input.reference})`,
    )
  }

  /**
   * A stand-in for the open invoice.
   *
   * Reports the lease's outstanding balance as a single invoice, with a
   * SYNTHETIC id - deliberately Stripe-shaped so everything downstream is
   * exercised against a realistic value, and deliberately derived from the
   * balance rather than from anything the caller passes, so the caller
   * cannot make it agree with itself (D-27).
   *
   * Coarser than real Stripe, which issues an invoice per period. Stated
   * rather than hidden: against the simulator, "the open invoice" and "the
   * whole balance" are the same number, so a part-payment refusal here fires
   * on the balance where production would fire on the period.
   */
  async getOpenInvoice(
    input: SubscriptionRef,
  ): Promise<{ stripeInvoiceId: string; amountRemainingCents: number } | null> {
    const payer = await prisma.leasePayer.findFirst({
      where: { stripeSubscriptionId: input.stripeSubscriptionId },
      select: { id: true, leaseId: true },
    })
    if (!payer) return null
    const amountRemainingCents = await leaseBalanceCents(payer.leaseId)
    if (amountRemainingCents <= 0) return null
    return {
      // Stable per payer, so a retry finds the same invoice rather than
      // inventing a second one.
      stripeInvoiceId: `in_sim${payer.id.slice(0, 16)}`,
      amountRemainingCents,
    }
  }

  async createPaymentIntent(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    rail: PaymentRail
    leasePayerId: string
    leaseId: string
    idempotencyKey: string
  }): Promise<{ stripePaymentIntentId: string; clientSecret: string }> {
    const stripePaymentIntentId = stripeId('pi')
    console.info(
      `[billing:simulated] payment intent ${stripePaymentIntentId} for ${input.amountCents}c ` +
        `by ${input.rail} on payer ${input.leasePayerId} (key ${input.idempotencyKey})`,
    )
    return {
      stripePaymentIntentId,
      clientSecret: `${stripePaymentIntentId}_secret_${randomBytes(8).toString('hex')}`,
    }
  }

  async createApplicationFeeCustomer(input: {
    applicantId: string
    applicationId: string
    propertyId: string
    name: string
    email: string | null
    phone: string | null
  }): Promise<ProvisionedCustomer> {
    const stripeCustomerId = stripeId('cus')
    console.info(
      `[billing:simulated] customer ${stripeCustomerId} for applicant ${input.applicantId} (${input.name})`,
    )
    return { stripeCustomerId }
  }

  async createApplicationFeePaymentIntent(input: {
    stripeCustomerId: string
    amountCents: number
    currency: string
    applicantId: string
    idempotencyKey: string
  }): Promise<{ stripePaymentIntentId: string; clientSecret: string }> {
    const stripePaymentIntentId = stripeId('pi')
    console.info(
      `[billing:simulated] application fee payment intent ${stripePaymentIntentId} for ` +
        `${input.amountCents}c on applicant ${input.applicantId} (key ${input.idempotencyKey})`,
    )
    return {
      stripePaymentIntentId,
      clientSecret: `${stripePaymentIntentId}_secret_${randomBytes(8).toString('hex')}`,
    }
  }

  async paymentMethodExpiry(
    stripePaymentMethodId: string,
  ): Promise<{ expMonth: number; expYear: number } | null> {
    return simulatedCardExpiry(stripePaymentMethodId)
  }

  /**
   * Always null - the simulator has no invoice PDFs (R-052, D-50).
   *
   * NOT A FABRICATED PDF, deliberately. Returning a plausible-looking
   * generated document would make every statement produced on the demo and
   * e2e paths carry attachments that are not evidence of anything, and the
   * one thing a court packet must never contain is a manufactured record that
   * looks like a provider's. Null is the honest answer, and the statement
   * prints the invoice as unattached-but-cited, which is exactly the outcome
   * a real provider outage produces too - so the path that says "we could not
   * get this one" is the path the tests actually exercise.
   */
  async getInvoicePdf(): Promise<Uint8Array | null> {
    return null
  }
}

/**
 * A deterministic-but-INDEPENDENT card expiry for a simulated payment method
 * (D-27, R-045).
 *
 * HASHED FROM THE ID, not read from anything the decision code sets. R-045's
 * card-expiring-soon scan compares this against "today"; if the simulator
 * answered from the same place the decision reads from - say, a fixed offset
 * from `createdAt` - the "it is expiring" branch could never fail to fire and
 * no test could tell a real check from a tautology. Hashing the id gives an
 * oracle nothing in this codebase chose, the same move `getOpenInvoice` above
 * makes by answering from the ledger rather than from the payer row the
 * switch is about.
 *
 * EXPORTED so a test can compute what the simulator will say for a given id
 * directly, rather than searching for one that lands in a target month.
 *
 * Spread across eight years from a FIXED epoch - not "now" - so the answer
 * for a given id never changes between two runs of the same test, and so
 * cards realistically sit on both sides of expired as the calendar moves.
 * All payment methods are simulated as cards; the id carries no rail, and
 * distinguishing a bank-debit method here would need information nothing
 * upstream currently records.
 */
export function simulatedCardExpiry(
  stripePaymentMethodId: string,
): { expMonth: number; expYear: number } {
  let hash = 0
  for (let i = 0; i < stripePaymentMethodId.length; i += 1) {
    hash = (hash * 31 + stripePaymentMethodId.charCodeAt(i)) | 0
  }
  const monthsFromEpoch = Math.abs(hash) % 96 // eight years
  const EPOCH_YEAR = 2024
  return {
    expMonth: (monthsFromEpoch % 12) + 1,
    expYear: EPOCH_YEAR + Math.floor(monthsFromEpoch / 12),
  }
}
