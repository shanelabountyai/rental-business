'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField } from '@/components/form/field.tsx'
import type { VendorFormState } from '@/lib/vendors/staff-actions.ts'

export interface VendorRecordDefaults {
  name?: string
  trades?: string
  contactName?: string
  email?: string
  phone?: string
  serviceAreas?: string
  licenseNumber?: string
  w9OnFile?: boolean
  coiExpiresOn?: string
  preferredRank?: number | ''
  emergencyAvailable?: boolean
}

export function VendorRecordForm({
  action,
  defaults,
  submitLabel,
}: {
  action: (state: VendorFormState, formData: FormData) => Promise<VendorFormState>
  defaults: VendorRecordDefaults
  submitLabel: string
}) {
  const [state, formAction] = useActionState<VendorFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <TextField label="Name" name="name" required defaultValue={defaults.name} error={errors.name} />
      <TextField
        label="Trades (comma-separated)"
        name="trades"
        required
        defaultValue={defaults.trades}
        error={errors.trades}
        hint="e.g. plumbing, hvac"
      />
      <TextField label="Contact name" name="contactName" defaultValue={defaults.contactName} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Email" name="email" type="email" defaultValue={defaults.email} />
        <TextField label="Phone" name="phone" type="tel" defaultValue={defaults.phone} />
      </div>
      <TextField
        label="Service areas (comma-separated)"
        name="serviceAreas"
        defaultValue={defaults.serviceAreas}
        hint="Cities or zip codes."
      />
      <TextField label="License number" name="licenseNumber" defaultValue={defaults.licenseNumber} />
      <CheckboxField label="W-9 on file" name="w9OnFile" defaultChecked={defaults.w9OnFile} />
      <TextField
        label="COI expires on"
        name="coiExpiresOn"
        type="date"
        defaultValue={defaults.coiExpiresOn}
        error={errors.coiExpiresOn}
      />
      <TextField
        label="Preferred rank (optional)"
        name="preferredRank"
        type="number"
        inputMode="numeric"
        min={0}
        defaultValue={defaults.preferredRank}
        error={errors.preferredRank}
        hint="Lower sorts first when a job in their trade is dispatched. Leave blank for no stated preference."
      />
      <CheckboxField
        label="Available for emergencies (after-hours)"
        name="emergencyAvailable"
        defaultChecked={defaults.emergencyAvailable}
      />
      <SubmitButton label={submitLabel} />
    </form>
  )
}
