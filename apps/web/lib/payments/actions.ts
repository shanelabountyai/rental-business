'use server'

import { balanceCents } from '@rental/core/ledger'
import {
  AMOUNT_REFUSALS,
  cardFeeFor,
  validatePaymentAmount,
} from '@rental/core/payments'
import type { CollectionMethod, PaymentRail } from '@rental/core/payments'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { payLinkRejection, verifyPayLink } from '@/lib/portal/pay-link.ts'

// The tenant pays (PAY-01, R-037).
//
// EVERY NUMBER IS RECOMPUTED HERE. The screen showed a balance and a fee;
// this trusts neither. Both are derived again from the ledger and the
// jurisdiction rule at the moment of payment, because the form the tenant
// submitted was rendered at some earlier moment and a charge, a late fee or
// somebody else's payment may have landed since. Taking an amount from a
// hidden field would let a stale page - or a hand-crafted request - decide
// what somebody owes.
//
// D-12 all the way down: core decides the amount and the fee, Stripe
// executes them. Stripe is never asked to work out what a tenant owes.

export interface PayFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
  /// Stripe's client secret for the hosted fields. The only thing this
  /// product ever holds about a payment method - no card or bank number
  /// reaches this server (master PRD §6.6).
  clientSecret?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function startPayment(
  _previous: PayFormState,
  formData: FormData,
): Promise<PayFormState> {
  const { scope } = await requireTenantWithScope()

  // THEIR OWN payer, found from their own scope. The form carries no payer
  // id at all - one that did would be an id somebody could change.
  const payer = await prisma.leasePayer.findFirst({
    where: { leaseId: { in: [...scope.leaseIds] }, tenantId: scope.tenantId, active: true },
    select: PAYER_SELECT,
  })
  return chargeResolvedPayer(payer, formData, null)
}

/**
 * The same payment, started from a pay-now link instead of a session
 * (PAY-01, R-046).
 *
 * SHARES `chargeResolvedPayer` WITH THE SESSION PATH, deliberately. That
 * function is where every number is recomputed from the ledger and the
 * jurisdiction rule, and a second copy of it here would be a second place
 * for a stale amount, a missed hold or an unapplied card-fee cap to live -
 * drifting silently until the day the two disagree about what somebody owes.
 * What differs between the two entry points is only HOW the payer is proved,
 * which is the part that genuinely differs.
 *
 * The token is re-verified HERE, not trusted from the page that rendered the
 * form. A page is rendered once and submitted later; a link revoked in
 * between must not still pay.
 */
export async function startPaymentFromLink(
  token: string,
  _previous: PayFormState,
  formData: FormData,
): Promise<PayFormState> {
  const link = await verifyPayLink(token)
  if (!link.ok) return { error: payLinkRejection(link.reason) }

  const payer = await prisma.leasePayer.findFirst({
    // Scoped to the ONE payer the token names - not to everything its tenant
    // is party to. A tenant on two tenancies has a link per payer, and the
    // one in August's reminder for unit A cannot pay unit B.
    where: { id: link.leasePayerId, active: true },
    select: PAYER_SELECT,
  })
  return chargeResolvedPayer(payer, formData, link.notificationKey)
}

/// Everything both entry points need off the payer row. One constant so the
/// two cannot select different columns and diverge in what they can check.
const PAYER_SELECT = {
  id: true,
  leaseId: true,
  propertyId: true,
  collectionMethod: true,
  collectionPaused: true,
  stripeCustomerId: true,
  lease: {
    select: {
      requireFullBalance: true,
      property: { select: { state: true, county: true } },
    },
  },
} as const

/**
 * Starts a payment against an already-proved payer.
 *
 * EVERY NUMBER IS RECOMPUTED HERE - see this file's header. Whichever way the
 * caller proved who they are, the balance, the fee and the hold are all
 * derived again at this moment.
 */
async function chargeResolvedPayer(
  payer: {
    id: string
    leaseId: string
    propertyId: string
    collectionMethod: string
    collectionPaused: boolean
    stripeCustomerId: string | null
    lease: {
      requireFullBalance: boolean
      property: { state: string; county: string | null }
    }
  } | null,
  formData: FormData,
  /// The LOGICAL send a pay-now link went out in, when this payment came
  /// from one (R-046) — see `PayLinkSubject.notificationKey`. Recorded on
  /// the audit entry so "did the reminder work" is answerable.
  notificationKey: string | null,
): Promise<PayFormState> {
  if (!payer) return { error: 'There is no account set up to pay against yet.' }
  if (!payer.stripeCustomerId) {
    return { error: 'Your payment account is not ready yet. Please contact the office.' }
  }
  if (payer.collectionPaused) {
    // PAY-12. Says nothing about why - a legal-action hold is not something
    // a payment screen explains, and R-047 owns the message that does.
    return { error: 'Online payments are not available on this account. Please contact the office.' }
  }

  const railInput = str(formData, 'rail')
  if (railInput !== 'ACH' && railInput !== 'CARD') {
    // RETAIL_CASH deliberately falls here: it is offered as unavailable and
    // has no driver, so a request naming it is refused rather than quietly
    // charged to a card - which would put a fee on a tenant who chose cash
    // specifically to avoid one.
    return { error: 'Choose how you would like to pay.' }
  }
  const rail: PaymentRail = railInput

  const dollars = str(formData, 'amountDollars')
  const amountCents = dollars ? Math.round(Number(dollars) * 100) : Number.NaN
  if (!Number.isInteger(amountCents)) {
    return {
      error: 'Check the amount.',
      fieldErrors: { amountDollars: 'Enter an amount like 1250.00' },
    }
  }

  // Recomputed, not trusted. See this file's header.
  const [entries, inFlight, rule] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { leaseId: payer.leaseId },
      select: { id: true, amountCents: true },
    }),
    prisma.payment.aggregate({
      where: { leasePayerId: payer.id, status: 'PENDING' },
      _sum: { amountCents: true },
    }),
    rulesFor(
      { state: payer.lease.property.state, county: payer.lease.property.county },
      new Date(),
    ).catch(() => null),
  ])

  const facts = {
    method: payer.collectionMethod as CollectionMethod,
    balanceCents: balanceCents(
      entries.map((row) => ({ ...row, type: '', occurredAt: new Date(0), description: '' })),
    ),
    inFlightCents: inFlight._sum.amountCents ?? 0,
    // THE WRITE PATH, not just the screen (R-039a). The pay form already
    // hides a partial amount when the owner requires the full balance, but a
    // hand-crafted request does not go through the form - and this is the
    // only place that actually refuses one.
    requireFullBalance: payer.lease.requireFullBalance,
  }

  const verdict = validatePaymentAmount(facts, amountCents)
  if (!verdict.ok) {
    return { error: AMOUNT_REFUSALS[verdict.refusal] }
  }

  // D-4: whether the card cost may be passed on is a jurisdiction fact, and
  // no rule means not permitted - charging a fee we cannot point at a rule
  // for is the wrong way to be wrong.
  const fee =
    rail === 'CARD'
      ? cardFeeFor(
          {
            cardSurchargePermitted: rule?.cardSurchargePermitted ?? false,
            cardSurchargeMaxBps: rule?.cardSurchargeMaxBps ?? null,
          },
          amountCents,
        )
      : null
  const totalCents = fee?.totalCents ?? amountCents

  try {
    const intent = await getBillingProvider().createPaymentIntent({
      stripeCustomerId: payer.stripeCustomerId,
      amountCents: totalCents,
      currency: 'usd',
      rail,
      leasePayerId: payer.id,
      leaseId: payer.leaseId,
      // Keyed on the FACT, not the attempt: this payer, this total, this
      // minute. A retry of a request that timed out AFTER Stripe created the
      // intent reuses it rather than becoming a second debit. The minute is
      // in the key so a tenant who genuinely means to pay the same amount
      // again later is not silently handed the old intent.
      idempotencyKey: `pay:${payer.id}:${totalCents}:${new Date().toISOString().slice(0, 16)}`,
    })

    // The INTENT is audited, not the outcome. Whether the money arrives is
    // Stripe's to tell us by webhook (D-11), and the ledger moves only then.
    // What this records is that a tenant asked to pay, and what they were
    // charged for the privilege - the fee is the part somebody disputes.
    await audit({
      action: 'payment.intent_created',
      entityType: 'LeasePayer',
      entityId: payer.id,
      propertyId: payer.propertyId,
      after: {
        rail,
        amountCents,
        feeCents: fee?.feeCents ?? 0,
        totalCents,
        feeCapped: fee?.cappedAtCents != null,
        stripePaymentIntentId: intent.stripePaymentIntentId,
        // WHICH MESSAGE THIS PAYMENT CAME FROM (PAY-01, R-046). Null for a
        // payment started from a signed-in session, which is the honest
        // answer rather than a guess - "did the reminder work" must not
        // count a payment nobody was reminded about.
        fromNotificationKey: notificationKey,
      },
    })

    revalidatePath('/portal/pay')
    return { clientSecret: intent.clientSecret, notice: 'Confirm your details to finish paying.' }
  } catch (error) {
    console.error(`[payments] could not start a payment for ${payer.id}`, error)
    return {
      error: 'We could not start that payment. Please try again in a moment, or contact the office.',
    }
  }
}
