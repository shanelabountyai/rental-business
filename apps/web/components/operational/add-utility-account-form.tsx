'use client'

import { UTILITY_TYPES } from '@rental/core/operational'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/operational/actions.ts'

const TYPE_LABELS: Record<string, string> = {
  ELECTRIC: 'Electric',
  GAS: 'Gas',
  WATER: 'Water',
  SEWER: 'Sewer',
  TRASH: 'Trash',
  OTHER: 'Other',
}

export function AddUtilityAccountForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-md">
      <FormAlerts state={state} />
      <SelectField
        label="Utility"
        name="type"
        idPrefix="utility"
        required
        error={errors.type}
        options={UTILITY_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] ?? t }))}
      />
      <TextField label="Provider" name="provider" idPrefix="utility" required error={errors.provider} />
      <TextField
        label="Account number"
        name="accountNumber"
        idPrefix="utility"
        required={false}
        error={errors.accountNumber}
      />
      <TextField
        label="Name on account during tenancy"
        name="nameOnAccountDuringTenancy"
        idPrefix="utility"
        required={false}
        error={errors.nameOnAccountDuringTenancy}
        hint="Usually the tenant's, once transferred."
      />
      <TextField
        label="Name on account during vacancy"
        name="nameOnAccountVacancy"
        idPrefix="utility"
        required={false}
        error={errors.nameOnAccountVacancy}
        hint="Who it reverts to (if anyone) between tenants."
      />
      <CheckboxField
        label="Landlord-revert agreement on file"
        name="landlordRevertAgreement"
      />
      <TextField label="Notes" name="notes" idPrefix="utility" required={false} error={errors.notes} />
      <SubmitButton label="Add utility account" />
    </form>
  )
}
