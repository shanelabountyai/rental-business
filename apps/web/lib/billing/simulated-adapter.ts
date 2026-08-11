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
        collectionPaused: true,
        lease: { select: { status: true } },
      },
    })
    if (!payer) return null
    const over = payer.lease.status === 'ENDED' || payer.lease.status === 'TERMINATED'
    return {
      // Deliberately reports what a real cancelled subscription would only
      // report AFTER we cancelled it - so a sweep that has not run yet still
      // sees `active` and decides to cancel.
      status: over && payer.stripeAmountCents === null ? 'canceled' : 'active',
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
}
