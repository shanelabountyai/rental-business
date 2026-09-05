'use client'

import { useActionState, useEffect } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { DepositFormState } from '@/lib/payments/deposit-actions.ts'

// One deposit trip (PAY-05, R-166): everything one receiver collected under
// one legal entity on one day, still undeposited. Its own component so
// `useActionState` runs once per card rather than once per page - several
// groups can be open at once without one card's pending state leaking into
// another's.
//
// THE CONFIRMATION DOES NOT LIVE HERE (R-044's trap, again). Creating a
// batch stamps every payment in it with a `depositBatchId`, so on the next
// server render THIS CARD IS GONE - the group it represented is no longer
// undeposited. A "here is your slip, print it" rendered inside the card
// would unmount itself in the same paint that shows it. `onCreated` bubbles
// the result up to a parent that outlives this card.

export interface DepositGroupView {
  /// legalEntityId|receivedOn|receivedByStaffId - the same key `groupForDeposit`
  /// groups by, so React's reconciliation never confuses two receivers who
  /// happen to share a display name.
  key: string
  receivedOn: string
  receivedByName: string
  entityName: string
  totalAmount: string
  payments: readonly {
    id: string
    description: string
    channelLabel: string
    checkNumber: string | null
    amount: string
  }[]
}

export function DepositGroupCard({
  group,
  action,
  onCreated,
}: {
  group: DepositGroupView
  action: (state: DepositFormState, formData: FormData) => Promise<DepositFormState>
  onCreated: (state: DepositFormState) => void
}) {
  const [state, formAction] = useActionState<DepositFormState, FormData>(action, {})

  useEffect(() => {
    if (state.documentId) onCreated(state)
    // onCreated is a stable setter from the parent's useState, not something
    // that should re-run this effect on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.documentId])

  return (
    <div data-testid="deposit-group" className="flex flex-col gap-3 rounded-lg border p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{group.receivedOn}</p>
          <p className="text-muted-foreground text-sm">
            {group.entityName} — collected by {group.receivedByName}
          </p>
        </div>
        <p className="text-lg font-semibold">{group.totalAmount}</p>
      </header>

      <ul className="flex flex-col divide-y text-sm">
        {group.payments.map((payment) => (
          <li key={payment.id} className="flex justify-between gap-2 py-1.5">
            <span>
              {payment.description}
              <span className="text-muted-foreground">
                {' '}
                — {payment.channelLabel}
                {payment.checkNumber ? ` #${payment.checkNumber}` : ''}
              </span>
            </span>
            <span className="tabular-nums">{payment.amount}</span>
          </li>
        ))}
      </ul>

      {/* Errors only - a success notice would race the unmount above and be
          announced to nobody. */}
      {state.error && <FormAlerts state={{ error: state.error }} />}
      <form action={formAction}>
        {group.payments.map((payment) => (
          <input key={payment.id} type="hidden" name="paymentId" value={payment.id} />
        ))}
        <SubmitButton label="Create deposit slip" />
      </form>
    </div>
  )
}
