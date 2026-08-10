import 'server-only'

import {
  type ProjectionIntent,
  type StripeEventEnvelope,
  interpretStripeEvent,
  ledgerAmountCents,
  movesLedger,
} from '@rental/core/billing'
import { prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'

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
      : intent.kind === 'payment_failed'
        ? 'FAILED'
        : 'REFUNDED'

  if (intent.stripePaymentIntentId) {
    const existing = await tx.payment.findUnique({
      where: { stripePaymentIntentId: intent.stripePaymentIntentId },
      select: { id: true },
    })
    if (existing) {
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
      // Stripe does not tell us ACH vs card on the invoice event itself.
      // OTHER is honest; R-037 owns the tenant-facing payment flow that
      // knows which rail was used and will narrow it.
      channel: 'OTHER',
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
