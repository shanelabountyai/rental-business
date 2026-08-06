'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { ScheduleResult } from '@/lib/workorders/scheduling.ts'

// Scheduling a visit (MAINT-05, R-027).
//
// The override field does NOT exist until the server says it is needed.
// That ordering is the point: a reason box sitting on screen from the start
// invites staff to fill it in pre-emptively and turns a deliberate override
// into a habit. It appears only after a real check against the property's
// own jurisdiction said this window is too soon, and it says by how much.

export function ScheduleForm({
  action,
  earliestCompliant,
  entryNoticeHours,
  scheduledStart,
  scheduledEnd,
  hasPermission,
  isEmergency,
}: {
  action: (state: ScheduleResult, formData: FormData) => Promise<ScheduleResult>
  /// Rendered as a hint so staff are steered to a lawful window rather than
  /// told off after picking one.
  earliestCompliant: string | null
  entryNoticeHours: number | null
  scheduledStart: string | null
  scheduledEnd: string | null
  hasPermission: boolean
  isEmergency: boolean
}) {
  const [state, formAction] = useActionState<ScheduleResult, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  // React 19 resets uncontrolled fields once a form action completes, so
  // these fall back to whatever was last submitted before falling back to
  // what is stored. Without it, the warn-and-override path clears the
  // window and reason the user just typed - on the one form where they are
  // already being told something is wrong.
  const startValue = state.values?.scheduledStart || scheduledStart || undefined
  const endValue = state.values?.scheduledEnd || scheduledEnd || undefined
  const reasonValue = state.values?.reason || undefined

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4 rounded-md border p-4">
      <h2 className="text-sm font-medium">Schedule the visit</h2>
      <FormAlerts state={state} />

      {isEmergency ? (
        <p className="text-muted-foreground text-sm">
          Emergency work order — entry notice is not required.
        </p>
      ) : hasPermission ? (
        <p className="text-muted-foreground text-sm">
          The tenant has given permission to enter, so no notice period applies.
        </p>
      ) : entryNoticeHours != null ? (
        <p className="text-muted-foreground text-sm">
          {/* One template string rather than JSX text around an expression:
              interpolating mid-sentence dropped the space and rendered
              "requires 24hours' notice", which is a sloppy thing for a
              compliance hint to say. */}
          {`This property's jurisdiction requires ${entryNoticeHours} hours' notice.${
            earliestCompliant ? ` The soonest compliant start is ${earliestCompliant}.` : ''
          }`}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          No entry-notice period is configured for this jurisdiction.
        </p>
      )}

      <TextField
        label="Window starts"
        name="scheduledStart"
        idPrefix="schedule"
        type="datetime-local"
        required
        defaultValue={startValue}
        // key: React reuses an uncontrolled input across renders and ignores
        // a changed defaultValue. Re-keying on the value forces the field to
        // actually pick up what was echoed back.
        key={`start-${startValue ?? ''}`}
        error={errors.scheduledStart}
      />
      <TextField
        label="Window ends"
        name="scheduledEnd"
        idPrefix="schedule"
        type="datetime-local"
        required
        defaultValue={endValue}
        key={`end-${endValue ?? ''}`}
        error={errors.scheduledEnd}
      />
      <TextField
        label="What the visit is for"
        name="reason"
        idPrefix="schedule"
        required
        defaultValue={reasonValue}
        key={`reason-${reasonValue ?? ''}`}
        error={errors.reason}
        hint="This goes on the notice the tenant receives."
      />

      {state.needsOverride && (
        <div className="flex flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
          <p className="text-sm font-medium">
            {state.needsOverride.shortfallHours} hour
            {state.needsOverride.shortfallHours === 1 ? '' : 's'} inside the{' '}
            {state.needsOverride.requiredHours}-hour notice period
          </p>
          <p className="text-muted-foreground text-sm">
            You can go ahead, but the reason is recorded permanently and is what this
            entry would be defended with.
          </p>
          <TextField
            label="Why are you going ahead?"
            name="overrideReason"
            idPrefix="schedule"
            required
            error={errors.overrideReason}
          />
        </div>
      )}

      <SubmitButton
        label={state.needsOverride ? 'Schedule anyway, with this reason' : 'Schedule and notify'}
      />
    </form>
  )
}
