'use client'

import {
  CONTACT_METHOD_LABELS,
  CONTACT_METHODS,
  CONTACT_OUTCOME_LABELS,
  CONTACT_OUTCOMES,
  ABANDONMENT_OUTCOME_LABELS,
  ABANDONMENT_OUTCOMES,
} from '@rental/core/abandonment'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { AbandonmentFormState } from '@/lib/abandonment/actions.ts'

// The abandonment case-file panels (RISK-01, R-087).
//
// Every form carries its own `caseId` in a hidden field rather than being
// handed a bound action per case — a `(id) => action` factory created on the
// server has no identity a client component can call back to (CLAUDE.md's
// Server→Client rule).

type Action = (state: AbandonmentFormState, formData: FormData) => Promise<AbandonmentFormState>

export function LogAttemptPanel({ caseId, action }: { caseId: string; action: Action }) {
  const [state, formAction] = useActionState<AbandonmentFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <input type="hidden" name="caseId" value={caseId} />
      <FormAlerts state={state} />
      <SelectField
        label="How did you try"
        name="method"
        required
        idPrefix="attempt"
        error={errors.method}
        options={CONTACT_METHODS.map((value) => ({
          value,
          label: CONTACT_METHOD_LABELS[value],
        }))}
      />
      {/* NOT "What happened", which the close-case form further down this
          same page already uses for its outcome note. Two controls with one
          accessible name are ambiguous to a locator and to anyone hearing
          them read out. */}
      <SelectField
        label="Result of the attempt"
        name="outcome"
        required
        idPrefix="attempt"
        error={errors.outcome}
        options={CONTACT_OUTCOMES.map((value) => ({
          value,
          label: CONTACT_OUTCOME_LABELS[value],
        }))}
      />
      <TextField
        label="Date of the attempt"
        name="attemptedOn"
        type="date"
        required
        idPrefix="attempt"
        error={errors.attemptedOn}
      />
      <TextField label="Note" name="note" idPrefix="attempt" />
      <SubmitButton label="Log this attempt" />
    </form>
  )
}

export function RecordEntryPanel({
  caseId,
  action,
  entryNoticeHours,
  state: stateName,
}: {
  caseId: string
  action: Action
  entryNoticeHours: number | null
  state: string
}) {
  const [state, formAction] = useActionState<AbandonmentFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <input type="hidden" name="caseId" value={caseId} />
      <FormAlerts state={state} />

      <p className="text-muted-foreground text-sm">
        {entryNoticeHours == null
          ? `${stateName}’s entry-notice period is not configured in this system, so nothing is checked against it. Ask your attorney before going in.`
          : `${stateName} requires ${entryNoticeHours} hours’ notice for a non-emergency entry.`}
      </p>

      <TextField
        label="When you went in"
        name="enteredAt"
        type="datetime-local"
        required
        idPrefix="entry"
        error={errors.enteredAt}
      />
      <TextField
        label="When notice was served"
        name="noticeServedAt"
        type="datetime-local"
        idPrefix="entry"
        hint="Leave blank if none was served — say why below."
      />

      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input type="checkbox" name="isEmergency" className="mt-1 size-5" />
        <span>
          <span className="font-medium">Treated as an emergency</span>
          <span className="text-muted-foreground block text-xs">
            A genuine welfare concern — a smell, a neighbour’s report, an
            unanswered door for weeks. Every jurisdiction that requires notice
            carves out emergencies.
          </span>
        </span>
      </label>

      <TextareaField
        label="What you found"
        name="entryFindings"
        required
        rows={4}
        idPrefix="entry"
        error={errors.entryFindings}
        hint="Post at the door, the state of the fridge, what furniture is left. This is the paragraph read most closely afterwards."
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="entry-photo" className="text-sm font-medium">
          A photo from inside
        </label>
        <input
          id="entry-photo"
          name="photo"
          type="file"
          accept="image/*"
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <p className="text-muted-foreground text-xs">
          The photo’s own timestamp is read from it and kept — a picture of an
          empty room proves nothing without when it was taken.
        </p>
        <FieldError id="entry-photo-error" message={errors.photo} />
      </div>

      {errors.overrideReason && (
        <TextField
          label="Why you went in anyway"
          name="overrideReason"
          required
          idPrefix="entry"
          error={errors.overrideReason}
        />
      )}

      <SubmitButton label="Record the entry" />
    </form>
  )
}

export function HoldBelongingsPanel({ caseId, action }: { caseId: string; action: Action }) {
  const [state, formAction] = useActionState<AbandonmentFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <input type="hidden" name="caseId" value={caseId} />
      <FormAlerts state={state} />
      <TextField
        label="Date the property was secured"
        name="belongingsHeldFrom"
        type="date"
        required
        idPrefix="hold"
        error={errors.belongingsHeldFrom}
        hint="The storage clock runs from this — not from when they were last seen."
      />
      <TextareaField
        label="Inventory"
        name="belongingsInventory"
        required
        rows={4}
        idPrefix="hold"
        error={errors.belongingsInventory}
        hint="What is being held, room by room. This is what answers a conversion claim."
      />
      <TextField
        label="Date notice of disposal was sent"
        name="belongingsNoticeSentOn"
        type="date"
        idPrefix="hold"
        hint="Only where this state requires one on top of the storage period."
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="hold-photo" className="text-sm font-medium">
          A photo of what is being held
        </label>
        <input
          id="hold-photo"
          name="photo"
          type="file"
          accept="image/*"
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>
      <SubmitButton label="Record the inventory" />
    </form>
  )
}

export function DisposePanel({
  caseId,
  action,
  refusal,
}: {
  caseId: string
  action: Action
  /// Computed server-side. When present the form is not offered at all —
  /// the server refuses either way, and showing the reason instead of a
  /// button is what stops somebody reaching for a workaround.
  refusal: string | null
}) {
  const [state, formAction] = useActionState<AbandonmentFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  if (refusal) {
    return (
      <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
        {refusal}
      </p>
    )
  }

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <input type="hidden" name="caseId" value={caseId} />
      <FormAlerts state={state} />
      <TextField
        label="What was done with it"
        name="note"
        required
        idPrefix="dispose"
        error={errors.note}
        hint="Sold, stored off site, discarded."
      />
      <SubmitButton label="Record the disposal" />
    </form>
  )
}

export function CloseCasePanel({
  caseId,
  action,
  deceasedPrompt,
}: {
  caseId: string
  action: Action
  deceasedPrompt: string
}) {
  const [state, formAction] = useActionState<AbandonmentFormState, FormData>(action, {})
  const [outcome, setOutcome] = useState('')
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex max-w-sm flex-col gap-3">
      <input type="hidden" name="caseId" value={caseId} />
      <FormAlerts state={state} />
      <SelectField
        label="How did this end"
        name="outcome"
        required
        idPrefix="close"
        error={errors.outcome}
        options={ABANDONMENT_OUTCOMES.map((value) => ({
          value,
          label: ABANDONMENT_OUTCOME_LABELS[value],
        }))}
        onChange={(event) => setOutcome(event.target.value)}
      />
      {outcome === 'DECEASED' && (
        <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
          {deceasedPrompt}
        </p>
      )}
      <TextField
        label="What happened"
        name="outcomeNote"
        required
        idPrefix="close"
        error={errors.outcomeNote}
      />
      <SubmitButton label="Close this case" />
    </form>
  )
}
