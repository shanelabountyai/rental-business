import 'server-only'

import {
  type ProjectionIntent,
  type StripeEventEnvelope,
  interpretStripeEvent,
  ledgerAmountCents,
  movesLedger,
} from '@rental/core/billing'
import { formatCents } from '@rental/core/money'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { leaseBalanceCents } from '@/lib/ledger/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The webhook → projection pipeline (D-11, R-034).
//
// "Our `LedgerEntry` table becomes an APPEND-ONLY PROJECTION built from
// Stripe webhooks... A row here that Stripe does not know about is a
// reconciliation bug, not a shortcut."
//
// The pipeline is four steps, in this order, and the order is the design:
//
//   1. VERIFY the signature (the route does this, before anything parses the
//      body) - see packages/core/billing/webhook-signature.ts.
//   2. CLAIM the event id. The INSERT into ProcessedStripeEvent is the lock:
//      a retried or concurrently-delivered event loses on the primary key
//      and stops. Claiming BEFORE projecting is what makes this idempotent;
//      claiming after would leave a window where two deliveries both project.
//   3. PROJECT, in one transaction with the rows it writes.
//   4. ACKNOWLEDGE. Stripe retries until it gets a 2xx, so anything we have
//      decided about - including "we ignored it" - must return success, or
//      Stripe retries forever and the dashboard fills with red.
//
// WHAT THIS DOES NOT DO. It does not compute anything. Late fees, proration,
// allocation order and days-past-due are core's (D-12) and are R-035's and
// R-040's work; a projector that started deciding amounts would be exactly
// the "Stripe generates a jurisdiction-dependent number" mistake D-12
// forbids, inverted.

export type PipelineOutcome =
  | 'projected'
  | 'ignored'
  /// Seen before. Not an error - it is the guarantee working.
  | 'duplicate'

export interface PipelineResult {
  outcome: PipelineOutcome
  detail?: string
}

/**
 * Handles one verified Stripe event.
 *
 * The signature must already have been checked by the caller. This function
 * deliberately takes a parsed envelope rather than a raw body, so it cannot
 * be called in a way that skips verification by accident - the only thing
 * that can produce an envelope is the route, after verifying.
 */
export async function processStripeEvent(
  event: StripeEventEnvelope,
): Promise<PipelineResult> {
  const interpretation = interpretStripeEvent(event)
  const occurredAt = new Date(event.created * 1000)

  // CLAIM FIRST. If this insert loses, another delivery of the same event is
  // already being handled (or was handled) and this one must do nothing.
  try {
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        // Provisional: updated below once the projection either lands or
        // does not. A row that says `received` and never moves is itself
        // useful - it means the projection threw after the claim.
        outcome: 'received',
        occurredAt,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { outcome: 'duplicate' }
    throw error
  }

  if (interpretation.outcome === 'ignore') {
    await recordOutcome(event.id, 'ignored', interpretation.reason)
    return { outcome: 'ignored', detail: interpretation.reason }
  }

  const intent = interpretation.intent
  const payer = await prisma.leasePayer.findFirst({
    where: { stripeCustomerId: intent.stripeCustomerId ?? undefined },
    select: { id: true, leaseId: true, propertyId: true },
  })
  if (!payer) {
    // An event for a customer we have never heard of. Recorded and
    // acknowledged rather than retried: guessing which lease it belongs to
    // would write money against the wrong tenancy, and Stripe retrying
    // forever would not make the customer appear.
    const detail = `no lease payer for customer ${intent.stripeCustomerId}`
    await recordOutcome(event.id, 'ignored', detail)
    return { outcome: 'ignored', detail }
  }

  await prisma.$transaction(async (tx) => {
    const payment = await writePayment(tx, event, intent, payer)

    if (movesLedger(intent)) {
      await tx.ledgerEntry.create({
        data: {
          propertyId: payer.propertyId,
          leaseId: payer.leaseId,
          leasePayerId: payer.id,
          type: intent.kind === 'refund' ? 'REVERSAL' : 'PAYMENT',
          amountCents: ledgerAmountCents(intent),
          description: intent.description,
          occurredAt: intent.occurredAt,
          paymentId: payment?.id ?? null,
          stripeEventId: event.id,
          stripeObjectId: intent.stripeObjectId,
        },
      })
    }
  })

  await recordOutcome(event.id, 'projected', intent.kind)

  // The receipt (PAY-01), OUTSIDE the transaction and only on settlement.
  //
  // Outside, because a notification provider being unreachable must not roll
  // back money that has already arrived - the ledger row is the fact, and the
  // message is a courtesy on top of it.
  //
  // ONLY ON SETTLEMENT, which is the whole reason `payment_pending` exists as
  // a separate kind. A receipt issued when an ACH debit is submitted is a
  // receipt for money that may never arrive, and it is the document a tenant
  // will later hold up to prove they paid.
  if (intent.kind === 'payment_succeeded') {
    await sendPaymentReceipt(payer, intent).catch((error) => {
      console.error(`[stripe] receipt failed for payer ${payer.id}`, error)
    })
  }

  return { outcome: 'projected', detail: intent.kind }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * The Payment row for this event, if the event is about one.
 *
 * Keyed on `stripePaymentIntentId`, which carries a unique constraint - so a
 * refund arriving for a payment we already recorded updates that row's
 * status rather than inserting a second one. Payment is deliberately NOT
 * append-only (unlike LedgerEntry): it is the current state of one attempt,
 * and Stripe moves it through pending → settled → refunded over time.
 */
async function writePayment(
  tx: Tx,
  event: StripeEventEnvelope,
  intent: ProjectionIntent,
  payer: { id: string; leaseId: string; propertyId: string },
) {
  if (intent.kind === 'dispute') return null

  const status =
    intent.kind === 'payment_succeeded'
      ? 'SETTLED'
      : intent.kind === 'payment_pending'
        ? 'PENDING'
        : intent.kind === 'payment_failed'
          ? 'FAILED'
          : 'REFUNDED'

  if (intent.stripePaymentIntentId) {
    const existing = await tx.payment.findUnique({
      where: { stripePaymentIntentId: intent.stripePaymentIntentId },
      select: { id: true, status: true },
    })
    if (existing) {
      // PENDING -> SETTLED is the whole point of PAY-01's "pending -> settled
      // states tracked", and the unique key on the PaymentIntent is what makes
      // it one row rather than two. `Payment` is not append-only - only
      // LedgerEntry, AuditLog, Message and Notification are - so advancing it
      // in place is legitimate, and it is what keeps a single ACH debit from
      // appearing twice on a tenant's history.
      //
      // NEVER BACKWARDS, though. Stripe does not promise webhook order, and a
      // `processing` arriving after its own `succeeded` would otherwise
      // un-settle a payment that has already moved the ledger.
      if (intent.kind === 'payment_pending' && existing.status !== 'PENDING') {
        return existing
      }
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          status,
          ...(intent.kind === 'refund' ? { reversedAt: intent.occurredAt } : {}),
        },
      })
      return existing
    }
  }

  return tx.payment.create({
    data: {
      propertyId: payer.propertyId,
      leaseId: payer.leaseId,
      leasePayerId: payer.id,
      // Narrowed where Stripe says so (R-037), `OTHER` where it does not -
      // the invoice events carry no payment method, and inventing one would
      // put a rail on a payment nobody can confirm used it.
      channel: intent.rail ?? 'OTHER',
      status,
      amountCents: intent.amountCents,
      receivedAt: intent.occurredAt,
      stripePaymentIntentId: intent.stripePaymentIntentId,
      stripeInvoiceId: intent.stripeInvoiceId,
    },
  })
}

async function recordOutcome(stripeEventId: string, outcome: string, detail?: string) {
  await prisma.processedStripeEvent.update({
    where: { stripeEventId },
    data: { outcome, detail: detail ?? null },
  })
}

/// The recent event log, for the operational screen R-036 will build out.
/// Exported here so this item leaves something readable behind rather than a
/// table only tests have ever selected from.
export async function recentStripeEvents(limit = 25) {
  return prisma.processedStripeEvent.findMany({
    orderBy: { occurredAt: 'desc' },
    take: limit,
  })
}

/**
 * "We got your rent" (PAY-01).
 *
 * Reads the balance AFTER the projection, which is the number a tenant
 * actually wants: "we received $1,500, you now owe $0" answers the question
 * that "we received $1,500" leaves open.
 *
 * Never throws into its caller. The money has already landed and the ledger
 * already says so; failing a webhook because Resend was down would have
 * Stripe redeliver an event we have correctly processed, and the claim row
 * would refuse it as a duplicate - so the retry would not even resend the
 * receipt it was retrying for.
 */
async function sendPaymentReceipt(
  payer: { id: string; leaseId: string; propertyId: string },
  intent: ProjectionIntent,
): Promise<void> {
  const lease = await prisma.lease.findUnique({
    where: { id: payer.leaseId },
    select: {
      property: { select: { addressLine1: true, timezone: true } },
      leaseTenants: {
        select: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
      },
    },
  })
  // The payer's own tenant, not every tenant on the lease: a receipt is
  // addressed to whoever's money it was.
  const payerRow = await prisma.leasePayer.findUnique({
    where: { id: payer.id },
    select: { tenantId: true },
  })
  const tenant = lease?.leaseTenants
    .map((row) => row.tenant)
    .find((row) => row.id === payerRow?.tenantId)
  if (!lease || !tenant) return

  const remaining = await leaseBalanceCents(payer.leaseId)

  // What the tenant was charged, split back out. The fee is on the audit
  // entry from the intent, which is the only place that knows it - Stripe
  // reports one total.
  const feeEntry = await prisma.auditLog.findFirst({
    where: {
      action: 'payment.intent_created',
      entityId: payer.id,
      // Matched on the intent id, so a tenant who paid twice in a day gets
      // the right fee on the right receipt.
      ...(intent.stripePaymentIntentId
        ? { after: { path: ['stripePaymentIntentId'], equals: intent.stripePaymentIntentId } }
        : {}),
    },
    select: { after: true },
    orderBy: { occurredAt: 'desc' },
  })
  const detail = (feeEntry?.after ?? null) as { feeCents?: number; amountCents?: number } | null
  const feeCents = detail?.feeCents ?? 0

  const outcomes = await notify({
    category: 'payment_receipt',
    templateKey: 'payment.receipt',
    recipient: {
      type: 'TENANT',
      id: tenant.id,
      email: tenant.email,
      phone: tenant.phone,
    },
    context: {
      tenantName: tenant.firstName,
      amount: formatCents(detail?.amountCents ?? intent.amountCents),
      feeAmount: feeCents > 0 ? formatCents(feeCents) : null,
      total: formatCents(intent.amountCents),
      addressLine1: lease.property.addressLine1,
      remaining: formatCents(Math.max(0, remaining)),
      paidOn: businessDate(intent.occurredAt, lease.property.timezone),
    },
    propertyId: payer.propertyId,
    // One receipt per payment, however many times Stripe tells us about it.
    idempotencyKey: `payment-receipt:${intent.stripePaymentIntentId ?? intent.stripeObjectId}`,
  })

  const deliveryIds = outcomes
    .map((outcome) => outcome.deliveryId)
    .filter((id): id is string => id != null)
  if (deliveryIds.length > 0) {
    await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
  }
}
