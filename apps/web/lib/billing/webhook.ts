import 'server-only'

import {
  type ProjectionIntent,
  type StripeEventEnvelope,
  interpretStripeEvent,
  ledgerAmountCents,
  movesLedger,
} from '@rental/core/billing'
import { formatCents } from '@rental/core/money'
import { returnAction, reversalAmountCents } from '@rental/core/payments'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { assessNsfFee } from '@/lib/ledger/nsf-fees.ts'
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

  // A FAILURE THAT MIGHT BE A RETURN (PAY-02, R-039).
  //
  // `invoice.payment_failed` arrives both when a first attempt is declined
  // and when an ACH debit is RETURNED days after it settled - Stripe gives
  // "instant provisional access" and takes up to four business days to
  // confirm. Reading only the event the two are indistinguishable; reading
  // our own Payment row they are obvious. Getting this wrong leaves the
  // credit in place and the tenant appearing to have paid, which is exactly
  // the failure PAY-02 names.
  const settled =
    intent.kind === 'payment_failed'
      ? await findSettledPayment(intent)
      : null

  // STALE FAILURES DO NOT REVERSE. Stripe promises neither ordering nor
  // exactly-once delivery, and one PaymentIntent can carry a decline followed
  // by a successful retry. Delivered out of order, the decline arrives after
  // we have already settled - and reading only the status would reverse money
  // that actually cleared, then fire the locked-category "your payment came
  // back" text at a tenant who paid.
  //
  // A genuine ACH return happens AFTER settlement; a stale decline before it.
  // `writePayment` stamps `receivedAt` from the succeeded event, so the two
  // timestamps are directly comparable. The symmetric guard already exists in
  // `writePayment` for a `payment_pending` arriving late; this is the half
  // that was missing.
  const staleFailure =
    intent.kind === 'payment_failed' &&
    settled?.status === 'SETTLED' &&
    intent.occurredAt < settled.receivedAt

  const action = staleFailure
    ? 'ignore'
    : intent.kind === 'payment_failed'
      ? returnAction(settled?.status ?? null)
      : null

  if (action === 'ignore') {
    // Either already reversed, or a stale decline that predates the
    // settlement. Both are acknowledged so Stripe stops retrying.
    const detail = staleFailure
      ? 'failure predates the settlement it would have reversed'
      : 'already reversed'
    await recordOutcome(event.id, 'ignored', detail)
    return { outcome: 'ignored', detail }
  }

  await prisma.$transaction(async (tx) => {
    if (action === 'reverse' && settled) {
      await reverseSettledPayment(tx, event, intent, payer, settled)
      return
    }

    const payment = await writePayment(tx, event, intent, payer)

    if (movesLedger(intent)) {
      // ONE ENTRY PER CHARGE WE RAISED, so each is linked to the row that
      // caused it. Everything that asks "what is still outstanding on this
      // fee" reads a charge's own ledger entries - `outstandingCharges()`,
      // the tenant pay screen, the late-fee delta arithmetic - and an
      // unlinked entry leaves all three answering "all of it" forever, which
      // showed up as a paid late fee sitting on the pay screen permanently.
      //
      // Rent from the subscription itself has no `Charge` row and so no id
      // to link: that lands as a single unlinked entry, which is correct
      // rather than a gap.
      const chargeIds = intent.chargeIds ?? []
      const linked = chargeIds.length > 0
        ? await tx.charge.findMany({
            where: { id: { in: chargeIds }, leaseId: payer.leaseId },
            select: { id: true, amountCents: true },
          })
        : []
      const linkedTotal = linked.reduce((total, row) => total + row.amountCents, 0)
      const sign = ledgerAmountCents(intent) < 0 ? -1 : 1
      const movedCents = Math.abs(ledgerAmountCents(intent))

      // LINKED ROWS MUST NOT EXCEED WHAT MOVED. A partial payment reports
      // only what arrived, while the charges named on the invoice carry their
      // full amounts - crediting each in full would forgive money nobody
      // sent. When they do not fit, fall back to a single unlinked row for
      // the actual amount: the balance stays right, and which charge it paid
      // down is a question for R-035's allocation policy rather than
      // something to guess at here.
      const fits = linkedTotal <= movedCents
      const rows = fits ? linked : []

      for (const row of rows) {
        await tx.ledgerEntry.create({
          data: {
            propertyId: payer.propertyId,
            leaseId: payer.leaseId,
            leasePayerId: payer.id,
            chargeId: row.id,
            type:
              intent.kind === 'charge_posted'
                ? 'CHARGE'
                : intent.kind === 'refund' || intent.kind === 'charge_voided'
                  ? 'REVERSAL'
                  : 'PAYMENT',
            amountCents: sign * row.amountCents,
            description: intent.description,
            occurredAt: intent.occurredAt,
            // CARRIES THE PAYMENT, like the remainder row below.
            //
            // Omitting it here was a real bug: `reverseSettledPayment` finds
            // the entries to undo BY `paymentId`, so a return reversed only
            // the remainder and left the linked charges credited forever. On
            // an invoice of a $500 late fee plus $700 rent, a returned $1,200
            // gave back $700 and left $500 of phantom credit - exactly the
            // PAY-02 failure this pipeline exists to prevent.
            paymentId: payment?.id ?? null,
            stripeEventId: event.id,
            stripeObjectId: intent.stripeObjectId,
          },
        })
      }

      // Whatever the invoice covered beyond charges we raised - the
      // subscription's own rent line, normally. Skipped when the linked rows
      // account for the whole amount, so an invoice made entirely of our own
      // charges does not also get an empty remainder row.
      const remainder = movedCents - (fits ? linkedTotal : 0)
      if (remainder <= 0) return

      await tx.ledgerEntry.create({
        data: {
          propertyId: payer.propertyId,
          leaseId: payer.leaseId,
          leasePayerId: payer.id,
          // Three kinds reach here and each is a different row. A charge
          // typed as a payment balances correctly and reads as a lie on the
          // statement, which is worse than being wrong loudly.
          type:
            intent.kind === 'charge_posted'
              ? 'CHARGE'
              : intent.kind === 'refund' || intent.kind === 'charge_voided'
                ? 'REVERSAL'
                : 'PAYMENT',
          amountCents: sign * remainder,
          description: intent.description,
          occurredAt: intent.occurredAt,
          paymentId: payment?.id ?? null,
          stripeEventId: event.id,
          stripeObjectId: intent.stripeObjectId,
        },
      })
    }
  })

  // One name for the outcome, used for the recorded row and the returned
  // value alike. Two spellings of the same fact is how a caller and a log
  // end up disagreeing about what happened.
  const outcomeDetail = action === 'reverse' ? 'payment_returned' : intent.kind
  await recordOutcome(event.id, 'projected', outcomeDetail)

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

  // The tenant is told their payment came back (PAY-02). Outside the
  // transaction and never throwing, for the same reason as the receipt: the
  // reversal is the fact, and a provider being down must not undo it.
  //
  // On a LOCKED SMS category, so a tenant cannot turn it off. Believing rent
  // is paid when it is not is how somebody ends up in eviction proceedings
  // over a bank error.
  if (action === 'reverse' && settled) {
    // THE FEE BEFORE THE NOTICE (R-039a). Ordering, not sequencing: the
    // notice quotes the fee, so raising it afterwards would mean telling the
    // tenant about a charge they will only see later - or telling them
    // nothing, which is what happened until now. Outside the transaction and
    // never throwing, like the notice itself: the reversal is the fact, and
    // neither a fee nor a message may undo it.
    const fee = await assessNsfFee({
      leaseId: payer.leaseId,
      propertyId: payer.propertyId,
      leasePayerId: payer.id,
      paymentId: settled.id,
    }).catch((error: unknown) => {
      console.error(`[stripe] NSF fee failed for payer ${payer.id}`, error)
      return null
    })

    await sendReturnNotice(
      payer,
      intent,
      settled.amountCents,
      // Only a fee that actually exists is quoted. `assessNsfFee` returns a
      // null chargeId for every legitimate no-fee case - the lease is silent,
      // the state forbids it, no rule is configured - and in all of them the
      // message must stay silent rather than invent a number.
      fee?.chargeId ? fee.amountCents : null,
    ).catch((error) => {
      console.error(`[stripe] return notice failed for payer ${payer.id}`, error)
    })
  }

  return { outcome: 'projected', detail: outcomeDetail }
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
  // A CHARGE is not a payment. Nobody has paid anything - a bill was issued -
  // so there is no Payment row to write, and falling through would have
  // created one in the `REFUNDED` state, which is nonsense that would then
  // show up on the tenant's payment history.
  if (intent.kind === 'charge_posted' || intent.kind === 'charge_voided') return null

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

/**
 * The settled payment this failure is about, if there is one.
 *
 * Matched on the PaymentIntent first and the invoice second. Stripe's
 * invoice-level failure events carry the intent where one exists, and the
 * invoice is the fallback for an out-of-band payment (R-038) that has no
 * intent at all - a check can bounce too, and it arrives here the same way.
 */
async function findSettledPayment(intent: ProjectionIntent) {
  const where = intent.stripePaymentIntentId
    ? { stripePaymentIntentId: intent.stripePaymentIntentId }
    : intent.stripeInvoiceId
      ? { stripeInvoiceId: intent.stripeInvoiceId }
      : null
  if (!where) return null

  return prisma.payment.findFirst({
    where,
    select: { id: true, status: true, amountCents: true, receivedAt: true },
    orderBy: { receivedAt: 'desc' },
  })
}

/**
 * Takes back a credit that turned out not to be money (PAY-02).
 *
 * A REVERSING ENTRY, never an edit or a delete - `LedgerEntry` is append-only
 * by database trigger and D-11 is explicit that corrections take this shape.
 * The new row points at the entry it reverses, so "why did this balance go
 * back up" is answerable from the row itself.
 *
 * The amount comes from THE SETTLED PAYMENT, not from the invoice. A partial
 * payment that returns must give back exactly what it gave, and an invoice
 * total is a different number.
 *
 * WHAT PAY-02 ASKS FOR BEYOND THIS, and where it currently stands: "no
 * downstream action that was triggered by the provisional payment remains
 * incorrectly in effect." Today the only such state is the balance itself -
 * late fees are computed from the ledger on demand (R-035), so restoring the
 * balance restores the correct fee position automatically, and nothing else
 * yet keys off a payment. When something does - a notice cancelled on
 * payment, most obviously (R-062) - it has to unwind here, and this comment
 * is the reminder.
 */
async function reverseSettledPayment(
  tx: Tx,
  event: StripeEventEnvelope,
  intent: ProjectionIntent,
  payer: { id: string; leaseId: string; propertyId: string },
  settled: { id: string; amountCents: number },
) {
  await tx.payment.update({
    where: { id: settled.id },
    data: {
      status: 'REVERSED',
      reversedAt: intent.occurredAt,
      reversalReason: 'Returned by the bank',
    },
  })

  // EVERY row the payment wrote, not the first one found.
  //
  // A single invoice produces one entry per charge it named plus a remainder
  // row for subscription rent, so `findFirst` undid one of them and left the
  // rest credited - a $1,200 return giving back $700 and stranding $500
  // against a late fee. One reversal per original also keeps the charge
  // linkage intact, so a fee that was paid and then returned goes back to
  // showing as outstanding on the pay screen rather than silently staying
  // settled.
  const originals = await tx.ledgerEntry.findMany({
    where: { paymentId: settled.id, type: 'PAYMENT' },
    select: { id: true, amountCents: true, chargeId: true },
  })

  if (originals.length === 0) {
    // Nothing linked to this payment - a projection written before the
    // linkage existed, or a payment recorded by another path. Fall back to
    // the payment's own amount so the balance is still restored; there is
    // simply nothing to point the reversal at.
    await tx.ledgerEntry.create({
      data: {
        propertyId: payer.propertyId,
        leaseId: payer.leaseId,
        leasePayerId: payer.id,
        type: 'REVERSAL',
        amountCents: reversalAmountCents(settled.amountCents),
        description: 'Payment returned by the bank',
        occurredAt: intent.occurredAt,
        paymentId: settled.id,
        stripeEventId: event.id,
        stripeObjectId: intent.stripeObjectId,
      },
    })
    return
  }

  for (const original of originals) {
    await tx.ledgerEntry.create({
      data: {
        propertyId: payer.propertyId,
        leaseId: payer.leaseId,
        leasePayerId: payer.id,
        type: 'REVERSAL',
        // From the ORIGINAL row, so a partial payment gives back exactly what
        // it gave - an invoice total is a different number.
        amountCents: reversalAmountCents(original.amountCents),
        description: 'Payment returned by the bank',
        occurredAt: intent.occurredAt,
        paymentId: settled.id,
        chargeId: original.chargeId,
        // Points AT what it undoes, which is what makes the pair legible to
        // somebody reading the statement.
        reversesId: original.id,
        stripeEventId: event.id,
        stripeObjectId: intent.stripeObjectId,
      },
    })
  }
}

/// "Your payment came back" (PAY-02). Reads the balance AFTER the reversal,
/// because what the tenant needs is the number they now owe rather than the
/// one that just disappeared.
async function sendReturnNotice(
  payer: { id: string; leaseId: string; propertyId: string },
  intent: ProjectionIntent,
  amountCents: number,
  /// The fee that was actually raised, or null when none was. Never a
  /// computed-but-unraised number (R-039a).
  feeCents: number | null,
): Promise<void> {
  const [lease, payerRow] = await Promise.all([
    prisma.lease.findUnique({
      where: { id: payer.leaseId },
      select: {
        property: { select: { addressLine1: true } },
        leaseTenants: {
          select: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
        },
      },
    }),
    prisma.leasePayer.findUnique({
      where: { id: payer.id },
      select: { tenantId: true },
    }),
  ])
  const tenant = lease?.leaseTenants
    .map((row) => row.tenant)
    .find((row) => row.id === payerRow?.tenantId)
  if (!lease || !tenant) return

  const balance = await leaseBalanceCents(payer.leaseId)

  const outcomes = await notify({
    category: 'payment_failed',
    templateKey: 'payment.returned',
    recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
    context: {
      tenantName: tenant.firstName,
      amount: formatCents(Math.abs(amountCents)),
      addressLine1: lease.property.addressLine1,
      balance: formatCents(Math.max(0, balance)),
      // R-039a raised it just above, so this can finally be a number. Still
      // null whenever no fee was raised - the lease is silent, the state
      // forbids it, no rule is configured - because the rule that made this
      // null for two items stands: never quote a fee nothing has charged.
      feeAmount: feeCents == null ? null : formatCents(feeCents),
    },
    propertyId: payer.propertyId,
    // One notice per returned payment, however many times Stripe tells us.
    idempotencyKey: `payment-returned:${intent.stripePaymentIntentId ?? intent.stripeObjectId}`,
  })

  const deliveryIds = outcomes
    .map((outcome) => outcome.deliveryId)
    .filter((id): id is string => id != null)
  if (deliveryIds.length > 0) {
    await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
  }
}
