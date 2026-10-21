'use client'

import { useActionState } from 'react'
import { type FormState, FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'

// R-266 (PRD 08 B5). Two kinds of form: the portfolio-wide one, and one per
// property for its quiet hours. Each property's controls and button carry the
// property's name, so no two controls on the page share an accessible name.

type Action = (state: FormState, formData: FormData) => Promise<FormState>

export function MessagingSettingsForm({
  action,
  businessName,
  replyTaskAssigneeStaffId,
  staff,
}: {
  action: Action
  businessName: string | null
  replyTaskAssigneeStaffId: string | null
  staff: { id: string; name: string }[]
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <TextField
        label="Business name"
        name="businessName"
        defaultValue={businessName ?? ''}
        hint="Every announcement text ends with this name and “Reply STOP to opt out.” Empty uses Rental Operations."
      />
      <SelectField
        label="Assign tenant replies to"
        name="replyTaskAssigneeStaffId"
        defaultValue={replyTaskAssigneeStaffId ?? 'anyone'}
        options={[
          { value: 'anyone', label: 'Anyone (unclaimed)' },
          ...staff.map((person) => ({ value: person.id, label: person.name })),
        ]}
      />
      <SubmitButton label="Save messaging settings" />
    </form>
  )
}

export function QuietHoursForm({
  action,
  property,
  hours,
}: {
  action: Action
  property: { id: string; name: string; quietHoursStart: number | null; quietHoursEnd: number | null }
  hours: { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="propertyId" value={property.id} />
      <FormAlerts state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={`Quiet from, ${property.name}`}
          name="quietHoursStart"
          idPrefix={property.id}
          defaultValue={property.quietHoursStart === null ? 'default' : String(property.quietHoursStart)}
          options={hours}
        />
        <SelectField
          label={`Quiet until, ${property.name}`}
          name="quietHoursEnd"
          idPrefix={property.id}
          defaultValue={property.quietHoursEnd === null ? 'default' : String(property.quietHoursEnd)}
          options={hours}
        />
      </div>
      <SubmitButton
        label={
          <>
            Save<span className="sr-only"> quiet hours for {property.name}</span>
          </>
        }
      />
    </form>
  )
}
