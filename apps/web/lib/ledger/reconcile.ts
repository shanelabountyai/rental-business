import 'server-only'

import { type Drift, detectDrift } from '@rental/core/ledger'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { billingIsLive } from '@/lib/billing/provider.ts'

// Reconciling the projection (D-11, R-035).
//
// The backlog's own words: "reconciled against Stripe on a schedule with
// drift alarmed, BECAUSE A PROJECTION NOBODY CHECKS IS A LIE WITH A
// TIMESTAMP."
//
// ==========================================================================
// WHAT THIS CHECK CAN AND CANNOT SEE. Worth being precise about, because a
// reconciliation everybody assumes is stronger than it is would be worse
// than none.
//
// It compares the ledger projection against the processed-event log, and
// catches every failure mode of R-034's pipeline that leaves a trace on our
// side:
//
//   - an event claimed and marked projected, with no ledger row to show for
//     it (money Stripe reported, missing from the books);
//   - a ledger row naming an event nobody has (either the log was truncated,
//     or something wrote to the projection directly, which D-11 forbids);
//   - a claim the pipeline died in the middle of.
//
// It DELIBERATELY DOES NOT compare amounts. `detectDrift` supports that and
// the external check will use it, but there is no independent amount to
// compare against here: `Payment.amountCents` and `LedgerEntry.amountCents`
// were both written from the same event, in the same transaction, by the
// same code. Checking one against the other would always pass and would
// look like coverage. The only source that could disagree is Stripe.
//
// And the gap that matters most: an event Stripe sent that we NEVER
// RECEIVED is invisible to this check by construction, because a webhook
// that never arrived leaves no trace on our side at all. Only asking Stripe
// what it thinks it sent would find that. `externalChecked` reports which of
// the two ran, on the record and on screen, rather than leaving somebody to
// assume.
//
// R-038a FOUND THE WORSE CASE, and it is worth naming because this header
// previously implied the external check would cover everything: an event
// Stripe NEVER SENT AT ALL. Offline payments were pushed with
// `paid_out_of_band`, for which Stripe emits no `invoice.payment_succeeded`
// - the event the pipeline subscribed to - so money that genuinely arrived
// left a Payment row, a paid invoice on Stripe, and no ledger entry. NEITHER
// half of this reconciliation could see it: there was no processed event to
// find a missing row for, and no ledger row to find a missing event for.
// Both sides agreed, because both sides were empty.
//
// What would catch its shape is a comparison this check does not do and
// deliberately does not pretend to: walking Stripe's OWN invoices for the
// window and asking whether each `amount_paid` is reflected in the
// projection. That is external reconciliation done properly and it belongs
// to its own item, not to a bug fix. The defect itself is closed at source -
// the pipeline now reads `invoice.updated`, which every money path emits.
// ==========================================================================

export interface ReconciliationReport {
  checkedEvents: number
  checkedEntries: number
  drift: Drift[]
  /// False until there is a Stripe account to compare against. Reported
  /// rather than implied: "reconciled" meaning two different things
  /// depending on configuration is exactly how a check stops being trusted.
  externalChecked: boolean
}

/**
 * Compares the ledger projection against the processed-event log.
 *
 * Bounded to a window rather than the whole history: the interesting drift
 * is recent, a full-table comparison grows without limit, and a nightly job
 * that gets slower every month is one somebody eventually disables. Anything
 * older than the window was already reported on the night it happened.
 */
export async function reconcileLedger(
  now = new Date(),
  windowDays = 30,
): Promise<ReconciliationReport> {
  const since = new Date(now.getTime() - windowDays * 86_400_000)

  const [events, entries] = await Promise.all([
    prisma.processedStripeEvent.findMany({
      where: { occurredAt: { gte: since } },
      select: { stripeEventId: true, outcome: true, type: true, detail: true },
    }),
    prisma.ledgerEntry.findMany({
      where: { occurredAt: { gte: since }, stripeEventId: { not: null } },
      select: { id: true, stripeEventId: true, amountCents: true },
    }),
  ])

  const drift = detectDrift(
    events.map((event) => ({
      stripeEventId: event.stripeEventId,
      outcome: event.outcome,
      type: event.type,
      // Null: no independent amount exists on this side - see the header.
      // A projected money event is still expected to have produced a row,
      // which is what `expectsLedgerRow` below tells detectDrift.
      amountCents: null,
      // Falls back to the event type when `detail` is absent. A row written
      // before the pipeline recorded a detail - or by any future path that
      // forgets to - must not silently escape the check by having nothing to
      // key on. Belt and braces, deliberately: under-reporting drift is the
      // failure mode that matters here.
      expectsLedgerRow: event.detail
        ? LEDGER_MOVING_KINDS.has(event.detail)
        : LEGACY_MONEY_MOVING_EVENTS.has(event.type),
    })),
    entries.map((entry) => ({
      id: entry.id,
      stripeEventId: entry.stripeEventId,
      amountCents: entry.amountCents,
    })),
  )

  if (drift.length > 0) {
    // ALARMED, not merely logged. An append-only projection that has drifted
    // cannot be quietly corrected - the fix is a reversing entry somebody
    // has to decide on - so the trail records the discrepancy at the moment
    // it was found, with the same permanence as the rows it is about.
    await auditAsSystem('ledger.reconcile', {
      action: 'ledger.drift_detected',
      entityType: 'LedgerEntry',
      entityId: 'reconciliation',
      after: {
        windowDays,
        checkedEvents: events.length,
        checkedEntries: entries.length,
        externalChecked: false,
        drift: drift.map((item) => ({
          kind: item.kind,
          stripeEventId: item.stripeEventId,
          ledgerEntryId: item.ledgerEntryId,
          differenceCents: item.differenceCents,
          detail: item.detail,
        })),
      },
    }).catch((error) => {
      console.error('[ledger] could not record drift', error)
    })

    for (const item of drift) {
      console.error(`[ledger] DRIFT ${item.kind}: ${item.detail}`)
    }
  }

  return {
    checkedEvents: events.length,
    checkedEntries: entries.length,
    drift,
    externalChecked: false,
  }
}

/// Event types that must produce a ledger row when they project. Kept beside
/// the sweep rather than imported from R-034's handler list, because the two
/// answer different questions: that list is "what do we interpret", this is
/// "what must have moved money". A failed payment is handled and projects a
/// Payment row, but moves no balance and is correctly rowless here.
/**
 * The projection kinds that write a `LedgerEntry`.
 *
 * KEYED ON WHAT THE PROJECTOR RECORDED, not on the Stripe event type, and
 * that distinction is the whole point. The same event type produces
 * different outcomes depending on history and content, so a set of type
 * names cannot answer "was a row expected here":
 *
 *   - `invoice.payment_failed` writes a REVERSAL when it is an ACH return
 *     against a settled payment (R-039), and nothing when it is a first
 *     decline. Keyed on the type, this said "no row expected" in both
 *     cases - so **a lost reversal, the most serious drift there is, was
 *     invisible to the check built to catch exactly that.**
 *   - `payment_intent.succeeded` projects only when it carries no invoice;
 *     the invoiced ones are ignored to avoid double-counting.
 *   - `invoice.finalized` writes the CHARGE half (R-040b) and was simply
 *     missing.
 *
 * `detail` carries the projection kind the pipeline actually chose, so this
 * stays correct as kinds are added rather than needing a second list kept in
 * step by hand.
 */
const LEDGER_MOVING_KINDS: ReadonlySet<string> = new Set([
  'charge_posted',
  'charge_voided',
  'payment_succeeded',
  'refund',
  'payment_returned',
])

/// The old type-keyed answer, kept ONLY for rows with no recorded detail.
/// Incomplete by construction - that is why it was replaced - but a partial
/// check on a legacy row beats none.
const LEGACY_MONEY_MOVING_EVENTS: ReadonlySet<string> = new Set([
  'invoice.finalized',
  'invoice.voided',
  'invoice.payment_succeeded',
  'charge.refunded',
])

/// Whether external reconciliation is even possible in this deployment.
/// Exported so the screen can say so rather than implying a check that did
/// not run.
export function externalReconciliationAvailable(): boolean {
  return billingIsLive()
}

/// Drift found on recent runs, for the screen. Read from the audit trail
/// rather than a table of its own - the trail is already append-only and
/// already the place this product records things that must not be edited.
export async function recentDrift(limit = 20) {
  return prisma.auditLog.findMany({
    where: { action: 'ledger.drift_detected' },
    orderBy: { occurredAt: 'desc' },
    take: limit,
    select: { id: true, occurredAt: true, after: true },
  })
}
