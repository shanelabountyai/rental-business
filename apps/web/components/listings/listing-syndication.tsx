'use client'

import { SYNDICATION_NETWORKS } from '@rental/core/listings'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField } from '@/components/form/field.tsx'
import type { SyndicationFormState } from '@/lib/listings/syndication.ts'

// Syndicating a listing (LEASE-02, R-057).

const NETWORK_LABELS: Record<string, string> = {
  ZILLOW: 'Zillow',
  APARTMENTS_COM: 'Apartments.com',
  ZUMPER: 'Zumper',
}

const STATUS_LABELS: Record<string, string> = {
  LISTED: 'Live',
  DELISTED: 'Delisted',
  FAILED: 'Failed',
}

export interface SyndicationRow {
  network: string
  status: string
  lastFaultCode: string | null
}

export function ListingSyndicationSection({
  action,
  canSyndicate,
  rows,
}: {
  action: (state: SyndicationFormState, formData: FormData) => Promise<SyndicationFormState>
  /// False when the listing is not PUBLISHED - the action refuses server-side
  /// too, but the form is not even offered for a state it will only reject.
  canSyndicate: boolean
  rows: readonly SyndicationRow[]
}) {
  const [state, formAction] = useActionState<SyndicationFormState, FormData>(action, {})
  const byNetwork = new Map(rows.map((row) => [row.network, row]))

  return (
    <section aria-labelledby="syndication" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="syndication" className="text-sm font-semibold">
        Syndication
      </h2>
      {!canSyndicate && (
        <p className="text-muted-foreground text-sm">Publish the listing first.</p>
      )}
      <ul className="flex flex-col gap-1 text-sm">
        {SYNDICATION_NETWORKS.map((network) => {
          const row = byNetwork.get(network)
          return (
            <li key={network} className="flex items-center justify-between">
              <span>{NETWORK_LABELS[network] ?? network}</span>
              <span className="text-muted-foreground">
                {row
                  ? `${STATUS_LABELS[row.status] ?? row.status}${
                      row.status === 'FAILED' && row.lastFaultCode
                        ? ` (${row.lastFaultCode})`
                        : ''
                    }`
                  : 'Not sent'}
              </span>
            </li>
          )
        })}
      </ul>
      {canSyndicate && (
        <form action={formAction} className="flex flex-col gap-3">
          <FormAlerts state={state} />
          <div className="flex flex-wrap gap-4">
            {SYNDICATION_NETWORKS.map((network) => (
              <CheckboxField
                key={network}
                label={NETWORK_LABELS[network] ?? network}
                name="networks"
                value={network}
              />
            ))}
          </div>
          <SubmitButton label="Send to selected networks" />
        </form>
      )}
    </section>
  )
}
