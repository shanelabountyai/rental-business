// Reconciling the projection (D-11, R-035). Pure - no database, no Stripe.
//
// The backlog's own words: "reconciled against Stripe on a schedule with
// drift alarmed, BECAUSE A PROJECTION NOBODY CHECKS IS A LIE WITH A
// TIMESTAMP."
//
// Under D-11 Stripe is the source of truth and `LedgerEntry` is a projection
// of it. A projection can be wrong in ways nothing else notices: an event
// that was claimed and then failed to project, a ledger row whose event
// nobody can find, an amount that does not match what Stripe reported. None
// of those raise an error at the time - the money screens just quietly show
// a number that is not what Stripe thinks.
//
// This module compares two lists and says what disagrees. `detectDrift`
// takes both sides as plain data, events we processed vs rows we wrote - see
// the app layer for how that runs today.
//
// R-163 adds the external check the header above used to say was somebody
// else's item: `detectLeaseBalanceDrift`, a SEPARATE comparison rather than a
// second use of `detectDrift`. That function is shaped around one Stripe
// event; the external check has no event to key on - Stripe's own invoice
// is the independent figure, and the only reading of it that means anything
// is "what does this LEASE still owe", which is what R-038a's actual miss
// looked like (an event Stripe never sent, invisible to any event-shaped
// check by construction).

export const DRIFT_KINDS = [
  /// An event we claimed and marked `projected`, with no ledger entry
  /// carrying its id. The projection was lost - the most serious kind,
  /// because money Stripe reported is missing from the books.
  'projected_but_missing',
  /// A ledger row whose `stripeEventId` matches no processed event. Either
  /// the log was truncated or something wrote to the projection directly,
  /// which D-11 forbids outright.
  'orphan_entry',
  /// An event claimed but never resolved either way - the pipeline died
  /// between the claim and the outcome.
  'stuck_claim',
  /// Amounts disagree for the same event.
  'amount_mismatch',
] as const
export type DriftKind = (typeof DRIFT_KINDS)[number]

export interface Drift {
  kind: DriftKind
  stripeEventId: string | null
  ledgerEntryId: string | null
  /// Set only by `detectLeaseBalanceDrift` below - the internal check is
  /// keyed on events and entries, which already name themselves.
  leaseId: string | null
  /// Plain language. This ends up in an alert somebody reads at 8am.
  detail: string
  /// Signed cents, when the drift is about an amount. Null otherwise.
  differenceCents: number | null
}

export interface ProcessedEventView {
  stripeEventId: string
  outcome: string
  type: string
  /// What STRIPE said the money was - only ever populated by the external
  /// check, which is the only side with an independent figure. The internal
  /// check passes null, because `Payment.amountCents` and
  /// `LedgerEntry.amountCents` were both written from the same event in the
  /// same transaction and comparing them would always pass while looking
  /// like coverage.
  amountCents: number | null
  /// Whether a projected event of this type must have produced a ledger row.
  /// An explicit flag rather than inferred from `amountCents`, so the
  /// internal check - which has no amount - can still catch a lost
  /// projection, which is the most serious drift there is.
  expectsLedgerRow: boolean
}

export interface LedgerEntryView {
  id: string
  stripeEventId: string | null
  amountCents: number
}

/**
 * Everything that disagrees between the event log and the projection.
 *
 * Returns an empty array when they agree, which is the answer on almost
 * every run - and the sweep says so, because "reconciled, nothing to report"
 * is information and silence is not.
 */
export function detectDrift(
  events: readonly ProcessedEventView[],
  entries: readonly LedgerEntryView[],
): Drift[] {
  const drift: Drift[] = []

  const entriesByEvent = new Map<string, LedgerEntryView[]>()
  for (const entry of entries) {
    if (!entry.stripeEventId) continue
    const list = entriesByEvent.get(entry.stripeEventId) ?? []
    list.push(entry)
    entriesByEvent.set(entry.stripeEventId, list)
  }

  const knownEvents = new Set(events.map((e) => e.stripeEventId))

  for (const event of events) {
    if (event.outcome === 'received') {
      drift.push({
        kind: 'stuck_claim',
        stripeEventId: event.stripeEventId,
        ledgerEntryId: null,
        leaseId: null,
        detail: `${event.type} was claimed but never resolved - the pipeline stopped between claiming it and recording an outcome.`,
        differenceCents: null,
      })
      continue
    }

    // Only events that were supposed to move money are expected to have
    // produced a row. An `ignored` event legitimately produced none, and so
    // does a projected event that moves no balance - a failed payment
    // records the attempt without changing what is owed.
    if (event.outcome !== 'projected' || !event.expectsLedgerRow) continue

    const rows = entriesByEvent.get(event.stripeEventId) ?? []
    if (rows.length === 0) {
      drift.push({
        kind: 'projected_but_missing',
        stripeEventId: event.stripeEventId,
        ledgerEntryId: null,
        leaseId: null,
        detail: `${event.type} was projected but no ledger entry carries its id - money Stripe reported is missing from the books.`,
        differenceCents: event.amountCents,
      })
      continue
    }

    // The amount check only runs when there is an independent figure to
    // check against, which today means never - see the field's own comment.
    if (event.amountCents == null) continue

    // Compared on ABSOLUTE value: the event reports what moved, the ledger
    // row carries the sign the projection decided. Comparing signed values
    // would report every payment as a mismatch.
    const projected = rows.reduce((sum, row) => sum + Math.abs(row.amountCents), 0)
    if (projected !== Math.abs(event.amountCents)) {
      drift.push({
        kind: 'amount_mismatch',
        stripeEventId: event.stripeEventId,
        ledgerEntryId: rows[0]!.id,
        leaseId: null,
        detail: `${event.type} reported ${Math.abs(event.amountCents)}c but the projection carries ${projected}c.`,
        differenceCents: projected - Math.abs(event.amountCents),
      })
    }
  }

  for (const entry of entries) {
    if (entry.stripeEventId && !knownEvents.has(entry.stripeEventId)) {
      drift.push({
        kind: 'orphan_entry',
        stripeEventId: entry.stripeEventId,
        ledgerEntryId: entry.id,
        leaseId: null,
        detail: `Ledger entry ${entry.id} names event ${entry.stripeEventId}, which is not in the processed-event log.`,
        differenceCents: null,
      })
    }
  }

  return drift
}

export interface LeaseBalanceView {
  leaseId: string
  /// Stripe's own figure for what this lease's payer(s) still owe: the sum
  /// of `amount_remaining` across every open invoice on the subscription(s),
  /// which is amount_due minus amount_paid. Null when Stripe could not be
  /// asked - a distinct answer from "nothing owed", the same distinction
  /// `switchDecision` draws, so a network hiccup does not get reported as
  /// drift.
  stripeBalanceCents: number | null
  /// What our own projection says is owed - `balanceCents` over the lease's
  /// `LedgerEntry` rows.
  projectedBalanceCents: number
}

/**
 * Compares Stripe's own idea of what a lease owes against the projection.
 *
 * The one comparison `detectDrift` cannot do (see its own field comments):
 * `Payment.amountCents` and `LedgerEntry.amountCents` are written from the
 * same event by the same code, so nothing internal can ever disagree with
 * itself. This asks the one party with an independent figure - Stripe's own
 * open invoices - which is what would have caught R-038a's actual miss: an
 * offline payment Stripe never emitted a subscribed event for left no trace
 * on either side of the internal check, but the balance it should have moved
 * was still wrong.
 */
export function detectLeaseBalanceDrift(leases: readonly LeaseBalanceView[]): Drift[] {
  const drift: Drift[] = []
  for (const lease of leases) {
    if (lease.stripeBalanceCents == null) continue
    const differenceCents = lease.projectedBalanceCents - lease.stripeBalanceCents
    if (differenceCents === 0) continue
    drift.push({
      kind: 'amount_mismatch',
      stripeEventId: null,
      ledgerEntryId: null,
      leaseId: lease.leaseId,
      detail: `Lease ${lease.leaseId}: Stripe's open invoices say ${lease.stripeBalanceCents}c still owed, the projection says ${lease.projectedBalanceCents}c.`,
      differenceCents,
    })
  }
  return drift
}
