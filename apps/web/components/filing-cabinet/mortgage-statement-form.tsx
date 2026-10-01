'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

/// The lender's Form 1098 for one year (RPT-07, R-081b). Only box 1 is
/// required — it is the only figure Schedule E needs, and refusing the row
/// until every box is transcribed means the interest gets recorded nowhere.
export function MortgageStatementForm({
  action,
  mortgageId,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  mortgageId: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const idPrefix = `statement-${mortgageId}`

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-md">
      <FormAlerts state={state} />
      <TextField
        label="Tax year"
        name="taxYear"
        idPrefix={idPrefix}
        type="number"
        required
        error={errors.taxYear}
        hint="The year the 1098 covers. Re-entering a year replaces the figure rather than adding to it."
      />
      <TextField
        label="Interest paid (box 1)"
        name="interestDollars"
        idPrefix={idPrefix}
        type="number"
        required
        error={errors.interestDollars}
        hint="Goes on Schedule E line 12, labelled as coming from the 1098."
      />
      <TextField
        label="Principal paid"
        name="principalDollars"
        idPrefix={idPrefix}
        type="number"
        required={false}
        error={errors.principalDollars}
        hint="Optional. Not a deduction — recorded for the file."
      />
      <TextField
        label="Escrow paid"
        name="escrowDollars"
        idPrefix={idPrefix}
        type="number"
        required={false}
        error={errors.escrowDollars}
      />
      <TextField label="Statement notes" name="notes" idPrefix={idPrefix} required={false} error={errors.notes} />
      <SubmitButton label="Record 1098" />
    </form>
  )
}
