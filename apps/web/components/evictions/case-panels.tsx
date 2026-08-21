'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { EvictionFormState } from '@/lib/evictions/actions.ts'

type Action = (state: EvictionFormState, formData: FormData) => Promise<EvictionFormState>

/// Advancing a stage. The date field is what the stage actually records - a
/// filing date, a judgment date - so it is labelled per stage rather than
/// generically, because "date" on a court form is never just a date.
export function AdvanceStagePanel({
  action,
  nextStage,
  nextLabel,
  dateLabel,
  needsTime,
}: {
  action: Action
  nextStage: string
  nextLabel: string
  dateLabel: string
  needsTime: boolean
}) {
  const [state, formAction] = useActionState<EvictionFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <FormAlerts state={state} />
      <input type="hidden" name="stage" value={nextStage} />
      {needsTime ? (
        <TextField label={dateLabel} name="courtDate" type="datetime-local" idPrefix="advance" required />
      ) : (
        <TextField label={dateLabel} name="stageDate" type="date" idPrefix="advance" required />
      )}
      <SubmitButton label={nextLabel} />
    </form>
  )
}

/// Closing a case. The outcome is required and so is its note - see the
/// action's own comment: "this is over" with no terms recorded is the record
/// that helps nobody a year later.
export function CloseCasePanel({
  action,
  outcomes,
}: {
  action: Action
  outcomes: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<EvictionFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <FormAlerts state={state} />
      <input type="hidden" name="stage" value="CLOSED" />
      <SelectField
        label="How did this end?"
        name="outcome"
        idPrefix="close"
        required
        options={outcomes}
        error={errors.outcome}
      />
      <TextField
        label="Terms and detail"
        name="outcomeNote"
        idPrefix="close"
        required
        error={errors.outcomeNote}
        hint="The agreed sum for cash-for-keys, the judge's stated reason. Somebody will ask."
      />
      <SubmitButton label="Close case" />
    </form>
  )
}

export function RecordCostPanel({
  action,
  costTypes,
}: {
  action: Action
  costTypes: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<EvictionFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <FormAlerts state={state} />
      <SelectField
        label="What was this for?"
        name="type"
        idPrefix="cost"
        required
        options={costTypes}
        error={errors.type}
      />
      <TextField
        label="Amount (dollars)"
        name="amountDollars"
        type="number"
        inputMode="decimal"
        step="0.01"
        min={0}
        idPrefix="cost"
        required
        error={errors.amountDollars}
      />
      <TextField
        label="Date incurred"
        name="incurredOn"
        type="date"
        idPrefix="cost"
        required
        error={errors.incurredOn}
      />
      <TextField
        label="Description"
        name="description"
        idPrefix="cost"
        required
        error={errors.description}
        hint="An attorney reads this line."
      />
      <SubmitButton label="Record cost" />
    </form>
  )
}

export function AttachNoticePanel({
  action,
  notices,
}: {
  action: Action
  notices: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<EvictionFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <FormAlerts state={state} />
      <SelectField label="Served notice" name="noticeId" idPrefix="attach" required options={notices} />
      <SubmitButton label="File under this case" />
    </form>
  )
}

/// The packet. One button, because PAY-14 says one click - and a returned
/// summary, because the export names any exhibit it could not attach (D-50)
/// and that sentence has to reach the screen.
export function ExportPacketPanel({ action }: { action: Action }) {
  const [state, formAction] = useActionState<EvictionFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label="Produce attorney packet" />
    </form>
  )
}
