'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormAlerts, pendingButtonProps } from '@/components/auth-form.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import type { RerunState } from '@/lib/platform/job-actions.ts'

// One cron child's "Re-run" on `/platform/jobs` (R-303b). Every row has one,
// so the accessible name says which: it starts with the visible "Re-run"
// (WCAG 2.5.3) and names the job and the org.
export function RerunButton({
  action,
  orgId,
  child,
  label,
}: {
  action: (state: RerunState, formData: FormData) => Promise<RerunState>
  orgId: string
  child: string
  label: string
}) {
  const [state, formAction] = useActionState<RerunState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <FormAlerts state={state} />
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="child" value={child} />
      <Press label={label} />
    </form>
  )
}

function Press({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      aria-label={`Re-run ${label}`}
      {...pendingButtonProps(pending)}
      className={`${SUBMIT_BUTTON_CLASSES} min-h-11 px-4 py-2 text-sm aria-disabled:cursor-not-allowed`}
    >
      {pending ? 'Working…' : 'Re-run'}
    </button>
  )
}
