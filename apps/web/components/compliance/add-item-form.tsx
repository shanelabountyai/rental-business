'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { ComplianceFormState } from '@/lib/compliance/actions.ts'

const ENTITY_LEVEL_TYPES = new Set(['LLC_ANNUAL_REPORT', 'REGISTERED_AGENT_RENEWAL'])

const TYPE_OPTIONS = [
  { value: 'RENTAL_LICENSE', label: 'Rental license' },
  { value: 'RENTAL_REGISTRATION', label: 'Rental registration' },
  { value: 'CO_INSPECTION', label: 'Certificate of occupancy inspection' },
  { value: 'PERIODIC_CITY_INSPECTION', label: 'Periodic city inspection' },
  { value: 'SMOKE_CO_CERTIFICATION', label: 'Smoke/CO detector certification' },
  { value: 'LEAD_DISCLOSURE', label: 'Lead disclosure (pre-1978)' },
  { value: 'HOA_OBLIGATION', label: 'HOA obligation' },
  { value: 'PROPERTY_TAX', label: 'Property tax due date' },
  { value: 'PROPERTY_TAX_APPEAL_WINDOW', label: 'Property tax assessment-appeal window' },
  { value: 'SECTION_8_INSPECTION', label: 'Section 8 (HCV) inspection' },
  { value: 'SECTION_8_RECERTIFICATION', label: 'Section 8 (HCV) recertification' },
  { value: 'LLC_ANNUAL_REPORT', label: 'LLC annual report' },
  { value: 'REGISTERED_AGENT_RENEWAL', label: 'Registered agent renewal' },
  { value: 'OTHER', label: 'Other' },
]

export function AddComplianceItemForm({
  action,
  properties,
  entities,
}: {
  action: (state: ComplianceFormState, formData: FormData) => Promise<ComplianceFormState>
  properties: readonly { id: string; name: string }[]
  entities: readonly { id: string; name: string }[]
}) {
  const [state, formAction] = useActionState<ComplianceFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const [type, setType] = useState('')
  const entityLevel = ENTITY_LEVEL_TYPES.has(type)

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Type"
        name="type"
        required
        idPrefix="compliance"
        error={errors.type}
        options={TYPE_OPTIONS}
        onChange={(event) => setType(event.target.value)}
      />
      {entityLevel ? (
        <SelectField
          label="Legal entity"
          name="legalEntityId"
          required
          idPrefix="compliance"
          error={errors.legalEntityId}
          options={entities.map((e) => ({ value: e.id, label: e.name }))}
        />
      ) : (
        <SelectField
          label="Property"
          name="propertyId"
          required
          idPrefix="compliance"
          error={errors.propertyId}
          options={properties.map((p) => ({ value: p.id, label: p.name }))}
        />
      )}
      <TextField label="Label" name="label" required error={errors.label} />
      <TextField label="Due" name="dueOn" type="date" required error={errors.dueOn} />
      <TextField
        label="Recurs every (months, optional)"
        name="recurrenceMonths"
        type="number"
        inputMode="numeric"
        min={1}
        error={errors.recurrenceMonths}
        hint="Leave blank for a one-time obligation."
      />
      <TextField
        label="Alert lead time (days)"
        name="leadTimeDays"
        type="number"
        inputMode="numeric"
        min={0}
        defaultValue={30}
        error={errors.leadTimeDays}
      />
      <SubmitButton label="Add item" />
    </form>
  )
}
