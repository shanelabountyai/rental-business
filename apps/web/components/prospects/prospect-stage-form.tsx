'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { StageFormState } from '@/lib/prospects/staff-actions.ts'

// Manually advancing a prospect (LEASE-07, R-058) - see advanceProspectStage's
// own comment for why this is a free-form select rather than a guarded
// transition machine.

const STAGE_OPTIONS = [
  { value: 'SHOWING', label: 'Showing' },
  { value: 'APPLIED', label: 'Applied' },
  { value: 'SCREENED', label: 'Screened' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SIGNED', label: 'Signed' },
]

export function ProspectStageForm({
  action,
  currentStatus,
}: {
  action: (state: StageFormState, formData: FormData) => Promise<StageFormState>
  currentStatus: string
}) {
  const [state, formAction] = useActionState<StageFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <FormAlerts state={state} />
      <SelectField
        label="Move to stage"
        name="status"
        idPrefix="prospect"
        defaultValue={currentStatus}
        options={STAGE_OPTIONS}
      />
      <SubmitButton label="Update" />
    </form>
  )
}
