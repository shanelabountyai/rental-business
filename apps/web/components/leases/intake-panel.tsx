'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton, useFocusWhen } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField } from '@/components/form/field.tsx'
import type { LeaseFormState } from '@/lib/leases/actions.ts'

// The inherited-tenancy outstanding items (RISK-08, R-033).
//
// SHOWN AS CONSEQUENCES, NOT AS A CHECKLIST. Each item says what happens if
// it stays open, because these are the things nobody chases: none of them
// blocks anything today, all of them get harder every week, and the cost
// only lands at move-out — by which point the seller has stopped answering
// and the paint no longer looks how it looked at closing.

export interface IntakeGapView {
  gap: string
  summary: string
  consequence: string
}

type Action = (state: LeaseFormState, formData: FormData) => Promise<LeaseFormState>

export function IntakePanel({
  gaps,
  resolveAction,
  baselineAction,
  canWrite,
}: {
  gaps: readonly IntakeGapView[]
  resolveAction: Action
  /// R-116: attaches the condition-as-found photographs. Its own action
  /// rather than another `item` branch on `resolveAction`, because this one
  /// carries files.
  baselineAction: Action
  canWrite: boolean
}) {
  const [state, formAction] = useActionState<LeaseFormState, FormData>(resolveAction, {})
  // ITS STATE LIVES UP HERE, NOT IN THE FORM (R-116). Attaching the baseline
  // closes the gap, and closing the gap unmounts the <li> the form is in - so
  // a `FormAlerts` inside it would be destroyed by the very response it was
  // there to report, which is R-044's rule. The regions render at panel level
  // and the form below only submits.
  const [baselineState, submitBaseline] = useActionState<LeaseFormState, FormData>(
    baselineAction,
    {},
  )
  const errors = state.fieldErrors ?? {}
  // Driven by the ACTION's notice, not by `gaps.length === 0` — an inherited
  // lease settled last week renders this section on an ordinary page load,
  // and focusing then would steal focus from somebody just reading (R-101d).
  const settledRef = useFocusWhen<HTMLHeadingElement>(
    Boolean(state.notice || baselineState.notice),
  )

  if (gaps.length === 0) {
    return (
      <section
        aria-labelledby="intake"
        className="flex flex-col gap-2 rounded-md border p-4"
      >
        <h2 id="intake" ref={settledRef} tabIndex={-1} className="text-lg font-semibold">
          Inherited at acquisition
        </h2>
        <p className="text-sm">
          Everything outstanding on this tenancy has been settled — the terms are
          confirmed, the deposit position is established, and a condition
          baseline is on file.
        </p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="intake"
      className="flex flex-col gap-4 rounded-md border border-amber-300 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="intake" ref={settledRef} tabIndex={-1} className="text-lg font-semibold">
          Inherited at acquisition — {gaps.length} thing
          {gaps.length === 1 ? '' : 's'} outstanding
        </h2>
        <p className="text-muted-foreground text-sm">
          None of these blocks anything today. All of them get harder every week.
        </p>
      </div>

      <FormAlerts state={state} />
      <FormAlerts state={baselineState} />

      <ul className="flex flex-col gap-3">
        {gaps.map((gap) => (
          <li key={gap.gap} className="flex flex-col gap-2 rounded-md border p-3">
            <p className="text-sm font-medium">{gap.summary}</p>
            <p className="text-muted-foreground text-sm">{gap.consequence}</p>

            {canWrite && gap.gap === 'estoppel' && (
              <form action={formAction}>
                <input type="hidden" name="item" value="estoppel" />
                <SubmitButton label="The tenant has confirmed these terms" />
              </form>
            )}

            {canWrite && gap.gap === 'deposit_transfer' && (
              <form action={formAction} className="flex flex-col gap-3">
                <input type="hidden" name="item" value="deposit_transfer" />
                <SelectField
                  label="What happened to the deposit?"
                  name="depositTransferStatus"
                  required
                  idPrefix="intake"
                  error={errors.depositTransferStatus}
                  options={[
                    { value: 'TRANSFERRED', label: 'The seller transferred it to us' },
                    { value: 'NOT_TRANSFERRED', label: 'The seller kept it' },
                  ]}
                />
                <TextField
                  label="How you established that"
                  name="depositTransferNote"
                  idPrefix="intake"
                  hint="Whatever the seller actually said, and what backs it up."
                />
                <SubmitButton label="Record it" />
              </form>
            )}

            {gap.gap === 'condition_baseline' &&
              (canWrite ? (
                <ConditionBaselineForm state={baselineState} action={submitBaseline} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  The photographs attach to this lease and are timestamped from
                  the photo itself, not from when somebody got round to
                  uploading them.
                </p>
              ))}
          </li>
        ))}
      </ul>
    </section>
  )
}

// THE PANEL SAID "Upload the photos below" AND THERE WAS NO BELOW (R-116,
// audit angle 23). The only "Condition as found" list on the page renders once
// photos exist, which is exactly false while this gap is open - so the one
// panel whose whole job is naming the next action named one that could not be
// taken from anywhere in the product. `CONDITION_BASELINE_DOCUMENT_TYPE` was
// read by one query, set by two tests, and written by nothing.
//
// The state is OWNED BY THE PANEL - see the comment there for why.
function ConditionBaselineForm({
  state,
  action,
}: {
  state: LeaseFormState
  action: (formData: FormData) => void
}) {
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-condition-baseline" className="text-sm font-medium">
          Condition-as-found photographs
          <span aria-hidden="true"> *</span>
        </label>
        <p id="field-condition-baseline-hint" className="text-muted-foreground text-sm">
          They attach to this lease and are timestamped from the photo itself,
          not from when you got round to uploading them. Pick the whole walk at
          once — half a house photographed is what happens when it has to be
          done one file at a time.
        </p>
        <input
          id="field-condition-baseline"
          name="files"
          type="file"
          accept="image/*"
          multiple
          required
          aria-invalid={Boolean(state.fieldErrors?.files) || undefined}
          aria-describedby={
            state.fieldErrors?.files
              ? 'field-condition-baseline-hint field-condition-baseline-error'
              : 'field-condition-baseline-hint'
          }
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        />
        <FieldError id="field-condition-baseline-error" message={state.fieldErrors?.files} />
      </div>
      <SubmitButton label="Attach these photographs" />
    </form>
  )
}
