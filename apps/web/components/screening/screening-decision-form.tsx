'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField } from '@/components/form/field.tsx'
import type { DecisionFormState } from '@/lib/screening/staff-actions.ts'

// One accept/decline form (LEASE-04, R-060) - the applicant id travels as a
// hidden field, not a bound action, the same call waiveCharge's own form
// makes and its own comment explains: binding one server action per row
// loses the handler's identity across the client boundary.

const DECISION_OPTIONS = [
  { value: 'APPROVED', label: 'Approve' },
  { value: 'APPROVED_WITH_CONDITIONS', label: 'Approve with conditions' },
  { value: 'DECLINED', label: 'Decline' },
]

export function ScreeningDecisionForm({
  action,
  applicantId,
  applicantName,
  outOfOrder,
}: {
  action: (state: DecisionFormState, formData: FormData) => Promise<DecisionFormState>
  applicantId: string
  /// One of these renders per applicant on the prospect page, so "Decision",
  /// "Individualized-assessment notes" and "Record decision" were the same
  /// three names two and three times over (R-116). The legend names the group
  /// and the button names the person.
  applicantName: string
  /// True when an earlier-completed application for this listing has no
  /// decision yet - shows the deviation-reason field up front instead of
  /// making staff guess why the form rejected a first attempt.
  outOfOrder: boolean
}) {
  const [state, formAction] = useActionState<DecisionFormState, FormData>(action, {})

  return (
    <form action={formAction} className="rounded border p-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Screening decision for {applicantName}</legend>
        <input type="hidden" name="applicantId" value={applicantId} />
        <FormAlerts state={state} />
        <SelectField
          label="Decision"
          name="decision"
          idPrefix={`screen-${applicantId}`}
          required
          options={DECISION_OPTIONS}
        />
        <TextareaField
          label="Individualized-assessment notes"
          name="notes"
          idPrefix={`screen-${applicantId}`}
          hint="Required for a decline or a conditional approval - why, considering the nature and age of anything found."
        />
        {outOfOrder && (
          <TextareaField
            label="Why decide this one out of order"
            name="deviationReason"
            idPrefix={`screen-${applicantId}`}
            hint="Another application for this listing completed earlier and has not been decided yet."
            rows={2}
          />
        )}
        <SubmitButton
          label={
            <>
              Record decision<span className="sr-only"> for {applicantName}</span>
            </>
          }
        />
      </fieldset>
    </form>
  )
}
