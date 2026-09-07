'use client'

import {
  CLARIFYING_PROMPTS,
  type MaintenanceCategory,
  applicableTroubleshootingSteps,
  isMaintenanceCategory,
} from '@rental/core/maintenance'
import { useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField } from '@/components/form/field.tsx'
import { TroubleshootingIllustration } from '@/components/portal/maintenance/troubleshooting-illustration.tsx'
import type { MaintenanceFormState } from '@/lib/maintenance/actions.ts'
import { INPUT_CLASSES } from '@/components/ui-classes.ts'
import { useActionState } from 'react'

const YES_NO_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
]

/// One option per lease-tenant (not per lease), so a lease with more than
/// one tenant on it offers each by name rather than forcing staff to guess
/// which one is on the phone.
export interface LoggableCaller {
  id: string
  label: string
}

/**
 * Staff's phone-side equivalent of the tenant maintenance wizard (R-019),
 * running the SAME script (MAINT-01, MAINT-02, R-177).
 *
 * ==========================================================================
 * WHY THE PROMPTS AND THE SCRIPT ARE HERE. This form used to be a category
 * and a free-text note, on the reasoning that "staff is writing up a call,
 * not completing a form themselves". The operator review found that
 * backwards: the PM is on the phone WITH the tenant, which is the one moment
 * the GFCI-in-another-room script can be read aloud and actually save a truck
 * roll — and `applicableTroubleshootingSteps`'s seven scripts were reachable
 * only from the portal wizard, the channel the fewest tenants use.
 *
 * The prompts are not decoration in front of the script, they are what
 * SELECTS it: the disposal reset only applies to somebody who said "Garbage
 * disposal", the pilot light only to "Heating". Asking the script without
 * asking the prompts would read a tenant advice for an appliance they do not
 * have.
 *
 * The free-text note stays, and stays required. A call has words in it that
 * no prompt asks for, and trading them for a tidy structured form would be
 * the wrong half to keep.
 * ==========================================================================
 *
 * The category and the prompt answers are client state because the questions
 * BELOW them depend on the answers ABOVE — the one thing this form needs
 * JavaScript for, on a staff screen behind a login, which is a different
 * audience from the tenant wizard's cheap phone on a weak connection (R-111).
 */
export function LogPhoneRequestForm({
  action,
  callers,
  categories,
}: {
  action: (
    state: MaintenanceFormState,
    formData: FormData,
  ) => Promise<MaintenanceFormState>
  callers: readonly LoggableCaller[]
  categories: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<MaintenanceFormState, FormData>(action, {})
  const [category, setCategory] = useState<MaintenanceCategory | null>(null)
  const [promptAnswers, setPromptAnswers] = useState<Record<string, string>>({})
  const errors = state.fieldErrors ?? {}

  const prompts = category ? CLARIFYING_PROMPTS[category] : []
  const steps = category ? applicableTroubleshootingSteps(category, promptAnswers) : []

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Who called"
        name="leaseTenantId"
        required
        defaultValue={callers.length === 1 ? callers[0]!.id : undefined}
        error={errors.leaseTenantId}
        options={callers.map((c) => ({ value: c.id, label: c.label }))}
      />
      <SelectField
        label="Category"
        name="category"
        required
        error={errors.category}
        options={categories}
        onChange={(event) => {
          const value = event.target.value
          setCategory(isMaintenanceCategory(value) ? value : null)
          // Answers to a previous category's questions do not survive
          // choosing a different one - the same reset the tenant wizard's
          // category step does, and for the same reason: "Toilet" is not an
          // answer to "which appliance".
          setPromptAnswers({})
        }}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-phone-notes" className="text-sm font-medium">
          What they reported <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="field-phone-notes"
          name="notes"
          rows={4}
          required
          aria-invalid={Boolean(errors.notes) || undefined}
          aria-describedby={errors.notes ? 'field-phone-notes-error' : undefined}
          className={INPUT_CLASSES}
        />
        <FieldError id="field-phone-notes-error" message={errors.notes} />
      </div>

      {/* The QUESTION is the label, every time. Two controls on one page must
          never share an accessible name, and a generic "Answer" repeated
          three times is exactly that - Playwright's strict mode would catch
          it as a confusing test failure rather than as what it is. */}
      {prompts.map((prompt) =>
        prompt.type === 'select' ? (
          <SelectField
            key={prompt.id}
            label={prompt.question}
            name={`p_${prompt.id}`}
            required
            error={errors[`prompt.${prompt.id}`]}
            options={(prompt.options ?? []).map((option) => ({
              value: option,
              label: option,
            }))}
            onChange={(event) =>
              setPromptAnswers((prev) => ({ ...prev, [prompt.id]: event.target.value }))
            }
          />
        ) : (
          <div key={prompt.id} className="flex flex-col gap-1.5">
            <label htmlFor={`field-p-${prompt.id}`} className="text-sm font-medium">
              {prompt.question} <span aria-hidden="true">*</span>
            </label>
            <textarea
              id={`field-p-${prompt.id}`}
              name={`p_${prompt.id}`}
              rows={2}
              required
              aria-invalid={Boolean(errors[`prompt.${prompt.id}`]) || undefined}
              aria-describedby={
                errors[`prompt.${prompt.id}`] ? `field-p-${prompt.id}-error` : undefined
              }
              className={INPUT_CLASSES}
              onChange={(event) =>
                setPromptAnswers((prev) => ({ ...prev, [prompt.id]: event.target.value }))
              }
            />
            <FieldError
              id={`field-p-${prompt.id}-error`}
              message={errors[`prompt.${prompt.id}`]}
            />
          </div>
        ),
      )}

      {steps.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Read these out while they are on the line</h2>
            <p className="text-muted-foreground text-sm">
              Each one is a real fix often enough to be worth the minute. Record
              what they say — a job dispatched without this is a truck roll
              nobody can defend later.
            </p>
          </div>
          {steps.map((step) => (
            <fieldset key={step.id} className="flex flex-col gap-3 rounded-md border p-4">
              {/* The legend is the fieldset's FIRST child. Several of these
                  stack on one screen, each offering the same two answers, and
                  a legend buried beside the illustration names none of them. */}
              <legend className="font-medium">{step.title}</legend>
              <div className="flex gap-4">
                <TroubleshootingIllustration stepId={step.id} />
                <p className="text-sm">{step.instructions}</p>
              </div>
              <div className="flex gap-4">
                {[
                  { value: 'TRIED', label: 'They tried it' },
                  { value: 'DECLINED', label: 'Not tried' },
                ].map((choice) => (
                  <label key={choice.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`t_${step.id}`}
                      value={choice.value}
                      required
                      className="h-4 w-4"
                    />
                    {choice.label}
                  </label>
                ))}
              </div>
              <FieldError
                id={`field-t-${step.id}-error`}
                message={errors[`troubleshooting.${step.id}`]}
              />
            </fieldset>
          ))}
        </section>
      )}

      <SelectField
        label="May we enter if they are not home?"
        name="entryPermission"
        required
        error={errors.entryPermission}
        options={YES_NO_OPTIONS}
      />
      <SelectField
        label="Is there a pet at home?"
        name="petWarning"
        required
        error={errors.petWarning}
        options={YES_NO_OPTIONS}
      />
      <SubmitButton label="Log request" />
    </form>
  )
}
