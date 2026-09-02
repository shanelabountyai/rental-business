import { formatCents } from '@rental/core/money'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

// R-147: the screens for readers that existed without one (R-145's list).
// Both panels are portfolio plumbing - drift audit rows and Stripe's event
// log carry no propertyId - so the page shows them only to an actor whose
// scope covers everything, the same rule announcement-history.ts already
// argues for. Plain server components, read-only by construction.
//
// Timestamps print in UTC deliberately: these rows hang off no property, so
// UTC is the honest answer rather than a guess, and `friendlyTimestamp`
// prints the abbreviation so it says which clock it is (the notifications
// log's own precedent).

interface DriftItem {
  kind: string
  stripeEventId: string | null
  ledgerEntryId: string | null
  differenceCents: number | null
  detail: string
}

export interface DriftRun {
  id: string
  occurredAt: Date
  checkedEvents: number
  checkedEntries: number
  items: DriftItem[]
}

/// `recentDrift` returns raw audit rows whose `after` is Json. Parsed here,
/// defensively - an audit row written before a field existed must render as
/// "unknown", not crash the money screen.
export function parseDriftRun(row: {
  id: string
  occurredAt: Date
  after: unknown
}): DriftRun {
  const after = (row.after ?? {}) as Record<string, unknown>
  const rawItems = Array.isArray(after.drift) ? after.drift : []
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    checkedEvents: typeof after.checkedEvents === 'number' ? after.checkedEvents : 0,
    checkedEntries: typeof after.checkedEntries === 'number' ? after.checkedEntries : 0,
    items: rawItems.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>
      return {
        kind: typeof item.kind === 'string' ? item.kind : 'unknown',
        stripeEventId: typeof item.stripeEventId === 'string' ? item.stripeEventId : null,
        ledgerEntryId: typeof item.ledgerEntryId === 'string' ? item.ledgerEntryId : null,
        differenceCents: typeof item.differenceCents === 'number' ? item.differenceCents : null,
        detail: typeof item.detail === 'string' ? item.detail : '',
      }
    }),
  }
}

export function ReconciliationDrift({
  available,
  runs,
}: {
  available: boolean
  runs: DriftRun[]
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Reconciliation drift</h2>
      <p className="text-muted-foreground text-sm">
        Where the ledger projection stopped agreeing with the Stripe events it
        is built from. A drifted row is never edited — the fix is a reversing
        entry somebody decides on.
        {!available &&
          ' Billing is simulated in this deployment, so only the internal projection check runs; Stripe’s own records are not consulted.'}
      </p>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No drift has ever been detected. Reconciliation only writes here when
          it finds a discrepancy.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Red plus words, never the copper accent - drift is an
                    alarm, and D-163 reserves red for exactly this. */}
                <span className="font-medium text-red-700">
                  {run.items.length}{' '}
                  {run.items.length === 1 ? 'discrepancy' : 'discrepancies'}
                </span>
                <span className="text-muted-foreground">
                  {friendlyTimestamp(run.occurredAt, 'UTC')}
                </span>
              </div>
              <p className="text-muted-foreground">
                Checked {run.checkedEvents} events against {run.checkedEntries}{' '}
                ledger entries.
              </p>
              <ul className="flex flex-col gap-1">
                {run.items.map((item, index) => (
                  <li key={index}>
                    {item.detail || item.kind}
                    {item.differenceCents !== null &&
                      ` — off by ${formatCents(item.differenceCents)}`}
                    {item.stripeEventId && (
                      <span className="text-muted-foreground">
                        {' '}
                        · {item.stripeEventId}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function StripeEventLog({
  events,
}: {
  events: Array<{
    stripeEventId: string
    type: string
    outcome: string
    detail: string | null
    occurredAt: Date
  }>
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Stripe event log</h2>
      <p className="text-muted-foreground text-sm">
        Every event the webhook has handled, and what it decided to do with it.
      </p>
      {events.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No Stripe events have been received yet.
        </p>
      ) : (
        <div
          className="overflow-x-auto rounded-md border"
          {...scrollableRegionProps('Stripe event log, scrolls sideways')}
        >
          <table className="w-full text-sm">
            <caption className="sr-only">
              Recent Stripe events with their type, outcome and when they
              happened.
            </caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="px-4 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Event
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.stripeEventId} className="border-t">
                  <td className="px-4 py-2 whitespace-nowrap">
                    {friendlyTimestamp(event.occurredAt, 'UTC')}
                  </td>
                  <td className="px-4 py-2">{event.type}</td>
                  <td className="px-4 py-2">
                    {event.outcome}
                    {event.detail && (
                      <span className="text-muted-foreground"> — {event.detail}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
