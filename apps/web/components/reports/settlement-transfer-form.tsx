'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { SettlementTransferState } from '@/lib/reports/settlement-actions.ts'

// Recording one entity's transfer out of the shared account (R-198).
//
// ONE OF THESE PER ENTITY CARD, so every label and the button carry the
// entity's name: three LLCs on the page would otherwise be three fields called
// "Amount", which is CLAUDE.md's shared-accessible-name trap at its most
// literal. `idPrefix` keeps the ids apart for the same reason.
//
// The range and the entity travel as hidden fields. The amount OWED does not -
// the action recomputes it, because a figure posted back from the browser is a
// figure anybody can edit. It is only the amount field's starting value.

export function SettlementTransferForm({
  action,
  entityId,
  entityName,
  from,
  to,
  owedDollars,
  today,
}: {
  action: (state: SettlementTransferState, formData: FormData) => Promise<SettlementTransferState>
  entityId: string
  entityName: string
  from: string
  to: string
  owedDollars: string
  today: string
}) {
  const [state, formAction] = useActionState<SettlementTransferState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const prefix = `settle-${entityId}`

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <input type="hidden" name="entity" value={entityId} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <TextField
        label={`Amount moved to ${entityName}`}
        name="amountDollars"
        idPrefix={prefix}
        inputMode="decimal"
        required
        defaultValue={owedDollars}
        error={errors.amountDollars}
        hint="What actually left the shared account. Usually less than the amount owed, by Stripe's fees."
      />
      {/* Native date input (D-8). `min` is the range's last day and `max` is
          today; the action refuses either side regardless. */}
      <TextField
        label={`Day the money was moved to ${entityName}`}
        name="transferredOn"
        type="date"
        idPrefix={prefix}
        required
        defaultValue={today}
        min={to}
        max={today}
        error={errors.transferredOn}
      />
      <TextField
        label={`Bank confirmation for ${entityName}`}
        name="reference"
        idPrefix={prefix}
        required
        error={errors.reference}
        hint="The confirmation or trace number that matches this transfer to a bank statement."
      />
      <SubmitButton
        label={
          <>
            Record the transfer<span className="sr-only"> to {entityName}</span>
          </>
        }
      />
    </form>
  )
}
