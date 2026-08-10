'use client'

import { formatCents } from '@rental/core/money'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { BillingFormState } from '@/lib/billing/actions.ts'

// Billing Runs (PAY-03, D-11, R-036).
//
// "A Billing Runs screen reading Stripe's invoice events with per-lease
// outcomes and a re-sync action for drift."
//
// FAILURES AND NEVER-SYNCED FIRST. A billing screen whose problems are
// somewhere in the middle of an alphabetical list is one nobody scans, and
// the whole reason this screen exists is that a subscription silently out of
// step with its lease bills the wrong person the wrong amount, indefinitely,
// with nothing else to notice.

const ACTION_LABELS: Record<string, string> = {
  in_sync: 'In step',
  provisioned: 'Opened',
  price_updated: 'Repriced',
  paused: 'Paused',
  resumed: 'Resumed',
  cancelled: 'Cancelled',
  not_applicable: 'Nothing to bill',
  failed: 'Failed',
}

export interface BillingRunRow {
  id: string
  leaseId: string
  payerName: string
  where: string
  leaseStatus: string
  rentCents: number
  hasSubscription: boolean
  collectionPaused: boolean
  lastSyncedAt: string | null
  lastSyncAction: string | null
  lastSyncError: string | null
}

export function BillingRuns({
  rows,
  live,
  providerName,
  resync,
}: {
  rows: readonly BillingRunRow[]
  live: boolean
  providerName: string
  resync: (state: BillingFormState, formData: FormData) => Promise<BillingFormState>
}) {
  const [state, action] = useActionState<BillingFormState, FormData>(resync, {})

  return (
    <section aria-labelledby="runs" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="runs" className="text-lg font-semibold">
          Billing runs
        </h2>
        {!live && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {providerName} provider — not real Stripe
          </span>
        )}
      </div>

      <FormAlerts state={state} />

      {!live && (
        <p className="text-muted-foreground text-sm">
          {/*
            Stated plainly rather than left to look like a clean bill of
            health: against the simulator both sides of a re-sync are the
            same record, so it can never find drift.
          */}
          Re-syncing against the simulator compares our record with itself, so it
          will always report agreement. Real drift can only be found against
          Stripe.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No payers in scope yet. A subscription opens when a lease goes live.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <span className="flex min-w-64 flex-col gap-0.5 text-sm">
                <span className="font-medium">{row.where}</span>
                <span className="text-muted-foreground">
                  {row.payerName} · {formatCents(row.rentCents)}/mo ·{' '}
                  {row.leaseStatus.toLowerCase().replace('_', '-')}
                  {row.collectionPaused && ' · collection on hold'}
                </span>
                {row.lastSyncError ? (
                  <span role="alert" className="text-sm text-red-700 dark:text-red-400">
                    {row.lastSyncError}
                  </span>
                ) : !row.hasSubscription ? (
                  <span className="text-sm text-amber-800 dark:text-amber-200">
                    No subscription — nothing will bill for this payer.
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    {row.lastSyncedAt
                      ? `${ACTION_LABELS[row.lastSyncAction ?? ''] ?? row.lastSyncAction} · ${row.lastSyncedAt}`
                      : 'Never synced'}
                  </span>
                )}
              </span>

              <form action={action}>
                <input type="hidden" name="leasePayerId" value={row.id} />
                <SubmitButton label="Re-sync" />
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
