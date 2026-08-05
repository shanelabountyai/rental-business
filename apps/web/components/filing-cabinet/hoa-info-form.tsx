'use client'

import type { HoaInfo } from '@rental/db'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/filing-cabinet/actions.ts'

export function HoaInfoForm({
  action,
  hoaInfo,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  hoaInfo: HoaInfo | null
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 sm:max-w-md">
      <FormAlerts state={state} />
      <TextField
        label="HOA name"
        name="name"
        idPrefix="hoa"
        required={false}
        defaultValue={hoaInfo?.name ?? undefined}
        error={errors.name}
      />
      <TextField
        label="Contact info"
        name="contactInfo"
        idPrefix="hoa"
        required={false}
        defaultValue={hoaInfo?.contactInfo ?? undefined}
        error={errors.contactInfo}
      />
      <CheckboxField
        label="Has a rental cap or restriction"
        name="hasRentalCap"
        defaultChecked={hoaInfo?.hasRentalCap}
      />
      <TextField
        label="Rental cap policy"
        name="rentalCapPolicy"
        idPrefix="hoa"
        required={false}
        defaultValue={hoaInfo?.rentalCapPolicy ?? undefined}
        error={errors.rentalCapPolicy}
        hint='Free text - e.g. "capped at 20% of units, waitlist as of 2024".'
      />
      <TextField
        label="Notes"
        name="notes"
        idPrefix="hoa"
        required={false}
        defaultValue={hoaInfo?.notes ?? undefined}
        error={errors.notes}
      />
      <SubmitButton label={hoaInfo ? 'Update HOA info' : 'Save HOA info'} />
    </form>
  )
}
