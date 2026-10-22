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
  reasons,
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
  /// R-269: the active `DecisionReason` rows. The picked reason is recorded
  /// on the decision; it stays out of the notice until counsel reviews the
  /// list (OQ-16, D-333).
  reasons: readonly { value: string; label: string }[]
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
        <SelectField
          label="Reason from the list"
          name="reasonCode"
          idPrefix={`screen-${applicantId}`}
          options={reasons}
        />
        <TextareaField
          label="Individualized-assessment notes"
          name="notes"
          idPrefix={`screen-${applicantId}`}
          hint="Required, with a reason from the list, for a decline or a conditional approval - why, considering the nature and age of anything found. The note is quoted in the adverse-action notice; the reason is recorded for the audit trail."
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

/// R-269 (PRD 08 C3): "request more info" - not a decision, so it sits
/// beside the decision form rather than inside its select.
export function InfoRequestForm({
  action,
  applicantId,
  applicantName,
}: {
  action: (state: DecisionFormState, formData: FormData) => Promise<DecisionFormState>
  applicantId: string
  applicantName: string
}) {
  const [state, formAction] = useActionState<DecisionFormState, FormData>(action, {})

  return (
    <form action={formAction} className="rounded border p-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Request more information from {applicantName}</legend>
        <input type="hidden" name="applicantId" value={applicantId} />
        <FormAlerts state={state} />
        <TextareaField
          label="What you need from them"
          name="request"
          idPrefix={`info-${applicantId}`}
          hint="For example, two recent pay stubs. This is recorded but not sent yet: contact the applicant yourself."
          rows={2}
        />
        <SubmitButton
          label={
            <>
              Request more info<span className="sr-only"> from {applicantName}</span>
            </>
          }
        />
      </fieldset>
    </form>
  )
}
