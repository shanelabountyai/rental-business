'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { PreventiveFormState } from '@/lib/maintenance/preventive-actions.ts'

/// "One action creates the batch across properties" (MAINT-08) - a single
/// button, not a form with fields, but still a real useActionState form so
/// the count-created/auto-assigned summary has somewhere to land.
///
/// TWO THINGS THE NAME HAS TO CARRY (R-115).
///
/// The template's name, because every row on the preventive page rendered
/// this same control and a screen-reader user listing the page's buttons
/// heard "Run batch (3 due)" once per template with nothing to tell them
/// apart - the `idPrefix`/`rowId` machinery elsewhere in the repo solved the
/// duplicate-*id* problem and stopped short of the duplicate-*name* one.
///
/// And nothing at all when nothing is due. The button used to read "Nothing
/// due" while remaining enabled and remaining wired to an action that creates
/// work orders across every property in scope: a control that states there is
/// nothing to do, and then does something. No control at all is this repo's
/// answer to that (`rent-roll-table.tsx` argues it), not a disabled one.
export function RunBatchButton({
  action,
  templateName,
  dueCount,
}: {
  action: (state: PreventiveFormState, formData: FormData) => Promise<PreventiveFormState>
  templateName: string
  dueCount: number
}) {
  const [state, formAction] = useActionState<PreventiveFormState, FormData>(action, {})

  if (dueCount === 0) {
    return <p className="text-muted-foreground text-sm">Nothing due.</p>
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton
        label={
          <>
            Run<span className="sr-only"> {templateName}</span> batch ({dueCount} due)
          </>
        }
      />
    </form>
  )
}
