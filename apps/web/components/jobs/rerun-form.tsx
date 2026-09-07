'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { rerunJobAction } from '@/lib/jobs/actions.ts'

// Inferred, not imported: `actions.ts` is a `'use server'` module, and this
// codebase has been bitten by pulling a type through one (the
// `PartyChangeFormState` build failure). The empty object is all the initial
// state is.
const EMPTY = {}

/**
 * The re-run control for one failed run (R-174).
 *
 * One `useActionState` per row rather than one for the whole panel, so a
 * result lands beside the run it belongs to. A shared state would put "it
 * failed again" under whichever row happened to render first, which on a
 * screen whose entire job is telling you which run went wrong is worse than
 * saying nothing.
 *
 * `FormAlerts` sits inside the form but outside every conditional, and the
 * form carries no `key` - both deliberate. A live region that is remounted, or
 * that arrives with its text already in it, announces nothing (R-101, and the
 * `formVersion` trap that undid it).
 *
 * The accessible name carries the job and the date because this panel renders
 * one of these per failed run, and a page of buttons all called "Re-run" is
 * ambiguous to anyone navigating by label.
 */
export function RerunForm({
  jobRunId,
  label,
}: {
  jobRunId: string
  label: string
}) {
  const [state, formAction] = useActionState(rerunJobAction, EMPTY)
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="jobRunId" value={jobRunId} />
      <FormAlerts state={state} />
      <div>
        <SubmitButton
          label={
            <>
              Re-run<span className="sr-only"> {label}</span>
            </>
          }
        />
      </div>
    </form>
  )
}
