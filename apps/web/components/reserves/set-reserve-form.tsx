'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/reserves/actions.ts'

// `idPrefix` MUST be unique per property. This form renders once per house on
// one page, and a shared prefix gives every section the same DOM ids - so
// `<label for="reserve-targetDollars">` in the third section points at the
// FIRST section's input. Clicking that label focuses the wrong house's field,
// and a screen reader announces the wrong one. It is also how the e2e specs
// found this: the fill landed on another property and the gap never appeared.
export function SetReserveForm({
  action,
  idPrefix,
  targetDollars,
  balanceDollars,
  balanceAsOf,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  idPrefix: string
  targetDollars: string
  balanceDollars: string
  balanceAsOf: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      {state.saved ? (
        <p role="status" className="text-muted-foreground text-sm">
          Saved.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Target"
          name="targetDollars"
          idPrefix={idPrefix}
          type="number"
          step="1"
          required
          defaultValue={targetDollars}
          error={errors.targetDollars}
        />
        <TextField
          label="Balance held"
          name="balanceDollars"
          idPrefix={idPrefix}
          type="number"
          step="1"
          required={false}
          defaultValue={balanceDollars}
          error={errors.balanceDollars}
          hint="What is actually in the account. Nothing here computes it."
        />
        <TextField
          label="Counted on"
          name="balanceAsOf"
          idPrefix={idPrefix}
          type="date"
          required={false}
          defaultValue={balanceAsOf}
          error={errors.balanceAsOf}
          hint="Required with a balance — an undated figure always reads as current."
        />
      </div>
      <SubmitButton label="Save reserve" />
    </form>
  )
}
