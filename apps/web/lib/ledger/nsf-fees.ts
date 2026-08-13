import 'server-only'

import { formatCents } from '@rental/core/money'
import { nsfFeeFor } from '@rental/core/payments'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// The returned-payment fee (PAY-02, R-039a; D-4, D-12).
//
// `nsfFeeFor` has existed since R-039 and nothing called it - so the tenant's
// returned-payment notice was deliberately silent about a fee, with a comment
// saying "R-039a owns the push; until then the message stays silent rather
// than quoting a fee that does not exist." This is that push.
//
// RAISED INLINE, BEFORE THE NOTICE, and that ordering is the design. The
// obvious alternative is an outbox event with a consumer, which is how ticket
// triage and make-ready work - but consumers run on the hourly cron, so the
// fee would land up to an hour after the notice that should have quoted it.
// The tenant would get "your payment came back" now and "you have been
// charged $25" later, which is two shocks where one honest sentence would do.
//
// Structurally this is `assessLateFees` with the schedule taken out: the
// Charge row is created FIRST so its id can ride into Stripe's metadata and
// come back on the invoice line, and a failed push leaves the Charge with a
// null `stripeInvoiceItemId` - recoverable and visible - rather than leaving
// an invoice item in Stripe naming a charge that does not exist.

export interface NsfFeeResult {
  /// Null when no fee was raised, with `reason` saying which of the several
  /// legitimate reasons applied. A returned payment that costs the tenant
  /// nothing is the NORMAL case on a lease that is silent.
  chargeId: string | null
  amountCents: number
  reason:
    | 'raised'
    | 'lease_silent'
    | 'not_permitted_here'
    | 'already_raised'
    | 'no_customer'
    | 'push_failed'
}

/**
 * Raise the fee for one returned payment, if the lease and the statute both
 * allow one.
 *
 * Idempotent on the payment: Stripe redelivers, and a tenant charged twice
 * for one bounced payment is a support call that starts from a position of
 * being wrong.
 */
export async function assessNsfFee(args: {
  leaseId: string
  propertyId: string
  leasePayerId: string
  /// The payment that came back. The fee is keyed to it, which is what makes
  /// a redelivered webhook harmless.
  paymentId: string
  now?: Date
}): Promise<NsfFeeResult> {
  const now = args.now ?? new Date()

  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: args.leaseId },
    select: { nsfFeeCents: true },
  })

  const property = await prisma.property.findUniqueOrThrow({
    where: { id: args.propertyId },
    select: { state: true, county: true },
  })
  // No configured rule means no fee, exactly as late fees treat it: D-4's
  // whole point is that a statutory number comes from configuration, and
  // inventing one for an unconfigured state is how a product charges an
  // unlawful fee in a market nobody has set up yet.
  const rule = await rulesFor({ state: property.state, county: property.county }, now).catch(
    () => null,
  )
  if (!rule) {
    return { chargeId: null, amountCents: 0, reason: 'not_permitted_here' }
  }
  const decision = nsfFeeFor(
    {
      nsfFeePermitted: rule.nsfFeePermitted,
      nsfFeeMaxCents: rule.nsfFeeMaxCents,
    },
    lease.nsfFeeCents,
  )

  if (!decision.permitted) {
    return { chargeId: null, amountCents: 0, reason: 'not_permitted_here' }
  }
  if (decision.amountCents === 0) {
    // The lease is silent. Not an error and not a gap - see nsfFeeFor.
    return { chargeId: null, amountCents: 0, reason: 'lease_silent' }
  }

  const existing = await prisma.charge.findFirst({
    where: { leaseId: args.leaseId, type: 'NSF_FEE', assessedOnPaymentId: args.paymentId },
    select: { id: true, amountCents: true },
  })
  if (existing) {
    return { chargeId: existing.id, amountCents: existing.amountCents, reason: 'already_raised' }
  }

  const payer = await prisma.leasePayer.findUniqueOrThrow({
    where: { id: args.leasePayerId },
    select: { stripeCustomerId: true },
  })

  // The description defends the charge, the same way the late-fee one does:
  // "we charged $25 because the lease says so and Texas permits it" survives
  // a dispute where a bare "Returned payment fee" does not.
  const description =
    decision.cappedAtCents != null
      ? `Returned payment fee (lease provides ${formatCents(decision.computedCents)}; capped at ${formatCents(decision.cappedAtCents)})`
      : `Returned payment fee (lease provides ${formatCents(decision.computedCents)})`

  const fee = await prisma.charge.create({
    data: {
      propertyId: args.propertyId,
      leaseId: args.leaseId,
      type: 'NSF_FEE',
      amountCents: decision.amountCents,
      description,
      dueOn: new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z'),
      assessedOnPaymentId: args.paymentId,
      // WHICH VERSION of the rule permitted this, and at what ceiling. "What
      // did the law say on the day we charged it" is the first question in a
      // dispute and cannot be reconstructed from today's row (D-4).
      jurisdictionRuleId: rule.id,
    },
  })

  if (!payer.stripeCustomerId) {
    // The Charge stands - the tenant owes it and the ledger should say so -
    // but there is nothing to push it to. Visible as a charge with no invoice
    // item, which is the same recoverable state a failed push leaves.
    return { chargeId: fee.id, amountCents: fee.amountCents, reason: 'no_customer' }
  }

  try {
    const item = await getBillingProvider().addInvoiceItem({
      stripeCustomerId: payer.stripeCustomerId,
      amountCents: decision.amountCents,
      currency: 'usd',
      description,
      chargeId: fee.id,
      // Keyed on the FACT - this returned payment - not on the attempt, so a
      // retried webhook adds the item once.
      idempotencyKey: `nsffee:${args.paymentId}`,
    })

    await prisma.charge.update({
      where: { id: fee.id },
      data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
    })
  } catch (error) {
    console.error(`[nsf-fee] failed to push charge ${fee.id} to the provider`, error)
    return { chargeId: fee.id, amountCents: fee.amountCents, reason: 'push_failed' }
  }

  await auditAsSystem('ledger.nsf_fee', {
    action: 'ledger.adjusted',
    entityType: 'Charge',
    entityId: fee.id,
    propertyId: args.propertyId,
    after: {
      type: 'NSF_FEE',
      amountCents: decision.amountCents,
      computedCents: decision.computedCents,
      cappedAtCents: decision.cappedAtCents ?? null,
      jurisdictionRuleId: rule.id,
      paymentId: args.paymentId,
    },
  }).catch((error) => {
    console.error(`[nsf-fee] failed to audit charge ${fee.id}`, error)
  })

  return { chargeId: fee.id, amountCents: fee.amountCents, reason: 'raised' }
}
