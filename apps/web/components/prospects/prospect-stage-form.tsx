'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField } from '@/components/form/field.tsx'
import type { StageFormState } from '@/lib/prospects/staff-actions.ts'

// Manually advancing a prospect (LEASE-07, R-058) - see advanceProspectStage's
// own comment for why this is a free-form select rather than a guarded
// transition machine, with one exception: R-061's adverse-action block on
// moving to APPROVED/SIGNED, which mirrors ScheduleForm's own
// warn-and-override shape (workorders/schedule-form.tsx).

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

  // React 19 resets uncontrolled fields once a form action completes - see
  // ScheduleForm's identical comment for why the warn-and-override path
  // echoes the submitted value back rather than losing it.
  const statusValue = state.values?.status || currentStatus

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <FormAlerts state={state} />
        <SelectField
          label="Move to stage"
          name="status"
          idPrefix="prospect"
          defaultValue={statusValue}
          key={`status-${statusValue}`}
          options={STAGE_OPTIONS}
        />
        <SubmitButton label={state.needsOverride ? 'Move ahead, with this reason' : 'Update'} />
      </div>

      {state.needsOverride && (
        <div className="flex flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
          <p className="text-sm font-medium">
            No adverse-action notice sent for{' '}
            {state.needsOverride.applicantNames.join(', ')}
          </p>
          <p className="text-muted-foreground text-sm">
            You can go ahead, but the reason is recorded permanently and is what this
            decision would be defended with.
          </p>
          <TextareaField label="Why are you going ahead?" name="overrideReason" idPrefix="prospect" />
        </div>
      )}
    </form>
  )
}
