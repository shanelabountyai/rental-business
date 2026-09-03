'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { FinishWalkResult } from '@/lib/inspections/actions.ts'

// Finishing the walk, with the entry-notice gate (R-157).
//
// Same shape as the work-order ScheduleForm's override block: the reason
// field does NOT exist until the server says it is needed. A reason box on
// screen from the start invites staff to fill it in pre-emptively and turns
// a deliberate override into a habit - it appears only after a real check
// said this walk entered an occupied unit with no notice served.

export function FinishWalkForm({
  action,
}: {
  action: (state: FinishWalkResult, formData: FormData) => Promise<FinishWalkResult>
}) {
  const [state, formAction] = useActionState<FinishWalkResult, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      {state.needsEntryOverride && (
        <div className="flex max-w-md flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
          <p className="text-sm font-medium">No entry notice was served for this walk</p>
          <p className="text-muted-foreground text-sm">
            You can record it anyway, but the reason is kept permanently and is what this entry
            would be defended with.
          </p>
          <TextField
            label="Why was entry made without notice?"
            name="entryOverrideReason"
            idPrefix="finish-walk"
            required
            error={state.fieldErrors?.entryOverrideReason}
          />
        </div>
      )}
      <SubmitButton
        label={state.needsEntryOverride ? 'Finish anyway, with this reason' : 'Finish walk'}
      />
    </form>
  )
}
