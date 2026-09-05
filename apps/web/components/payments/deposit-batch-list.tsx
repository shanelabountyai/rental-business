'use client'

import { useState } from 'react'
import { DepositGroupCard, type DepositGroupView } from './deposit-group-card.tsx'
import type { DepositFormState } from '@/lib/payments/deposit-actions.ts'

// The stable home for a batch's confirmation (see DepositGroupCard's own
// header for why it cannot live inside the card that created it). Mounted
// unconditionally, aria-live, so the confirmation is announced even though
// the row that triggered it is gone by the time this paints - the same
// always-mounted-region rule R-101 established for exactly this failure.

export function DepositBatchList({
  groups,
  action,
}: {
  groups: readonly DepositGroupView[]
  action: (state: DepositFormState, formData: FormData) => Promise<DepositFormState>
}) {
  const [lastCreated, setLastCreated] = useState<DepositFormState | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="contents">
        {lastCreated?.documentId && (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {lastCreated.notice}{' '}
            <a
              href={`/api/documents/${lastCreated.documentId}/file`}
              className="underline underline-offset-4"
            >
              Print the slip
            </a>
          </p>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing undeposited right now.</p>
      ) : (
        groups.map((group) => (
          <DepositGroupCard
            key={group.key}
            group={group}
            action={action}
            onCreated={setLastCreated}
          />
        ))
      )}
    </div>
  )
}
