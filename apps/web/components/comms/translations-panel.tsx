'use client'

import { useActionState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import { FieldError, TextField } from '@/components/form/field.tsx'
import type { TemplateFormState } from '@/lib/comms/template-actions.ts'

// Translations, and the sign-off that makes one usable (COMM-03, R-049).
//
// ==========================================================================
// THE APPROVAL STATE IS THE LOUDEST THING ON THIS PANEL, deliberately.
//
// An unapproved translation on a LEGAL notice is not inert and it is not a
// draft sitting harmlessly in a drawer: it means every tenant who reads that
// language is receiving the notice in English instead, silently, and nobody
// finds out unless a screen says so. `languageFor` reports it; this is where
// a person sees it.
// ==========================================================================

interface Translation {
  id: string
  locale: string
  subject: string | null
  body: string
  approvedAt: string | null
  approvedByName: string | null
}

function ApproveForm({
  translation,
  approveAction,
}: {
  translation: Translation
  approveAction: (
    translationId: string,
    previous: TemplateFormState,
    formData: FormData,
  ) => Promise<TemplateFormState>
}) {
  const [state, action, pending] = useActionState<TemplateFormState, FormData>(
    approveAction.bind(null, translation.id),
    {},
  )

  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <TextField
        label="Who reviewed this, and on what basis"
        name="reason"
        required
        error={state.fieldErrors?.reason}
        hint="Recorded on the audit trail. This is the record that a person with authority read these words."
        idPrefix={`approve-${translation.locale}`}
      />
      <FieldError id={`approve-${translation.locale}-error`} message={state.error} />
      <LiveRegion>{state.notice && <p className="text-sm">{state.notice}</p>}</LiveRegion>
      <button
        type="submit"
        disabled={pending}
        className="bg-foreground text-background min-h-11 self-start rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        Approve this translation
      </button>
    </form>
  )
}

export function TranslationsPanel({
  isLegal,
  canApprove,
  translations,
  saveAction,
  approveAction,
  retireAction,
  active,
}: {
  templateId: string
  isLegal: boolean
  canApprove: boolean
  translations: Translation[]
  saveAction: (
    previous: TemplateFormState,
    formData: FormData,
  ) => Promise<TemplateFormState>
  approveAction: (
    translationId: string,
    previous: TemplateFormState,
    formData: FormData,
  ) => Promise<TemplateFormState>
  retireAction: (
    previous: TemplateFormState,
    formData: FormData,
  ) => Promise<TemplateFormState>
  active: boolean
}) {
  const [addState, addAction, addPending] = useActionState<TemplateFormState, FormData>(
    saveAction,
    {},
  )
  const [retireState, retireFormAction, retirePending] = useActionState<
    TemplateFormState,
    FormData
  >(retireAction, {})

  return (
    <section aria-labelledby="translations" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="translations" className="text-lg font-semibold">
        Other languages
      </h2>

      <p className="text-muted-foreground text-sm">
        {isLegal
          ? 'This is a legal notice, so only an approved translation will be sent. Until one is approved, tenants who read that language get the English version.'
          : 'A routine message can go out in any translation you have added, approved or not.'}
      </p>

      {translations.length > 0 && (
        <ul className="flex flex-col gap-3">
          {translations.map((translation) => (
            <li key={translation.id} className="rounded-lg border p-3">
              <p className="text-sm font-medium">
                {translation.locale}
                {translation.approvedAt ? (
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    — approved
                    {translation.approvedByName ? ` by ${translation.approvedByName}` : ''}
                  </span>
                ) : (
                  <span className="font-normal text-amber-800 dark:text-amber-200">
                    {' '}
                    — not approved
                    {isLegal && ', so it is not being used'}
                  </span>
                )}
              </p>
              <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
                {translation.body}
              </p>
              {!translation.approvedAt && canApprove && (
                <ApproveForm translation={translation} approveAction={approveAction} />
              )}
              {!translation.approvedAt && !canApprove && (
                <p className="text-muted-foreground mt-2 text-sm">
                  Somebody with approval rights needs to review this.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer">Add or replace a translation</summary>
        <form action={addAction} className="mt-2 flex flex-col gap-3">
          <TextField
            label="Language code"
            name="locale"
            required
            error={addState.fieldErrors?.locale}
            hint="As the tenant's profile records it — “es”, “vi”, “zh-Hant”."
            idPrefix="translation"
          />
          <TextField
            label="Subject line"
            name="subject"
            error={addState.fieldErrors?.subject}
            idPrefix="translation"
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="field-translation-body" className="text-sm font-medium">
              Translated message
              <span aria-hidden="true"> *</span>
            </label>
            <p className="text-muted-foreground text-sm">
              {/* The trap worth naming on the screen: a translator will
                  translate the merge fields too, and the result ships with a
                  visible token in it. */}
              Leave the <code>{'{{merge_fields}}'}</code> exactly as they are —
              translate the words around them.
            </p>
            <textarea
              id="field-translation-body"
              name="body"
              required
              rows={8}
              aria-invalid={addState.fieldErrors?.body ? true : undefined}
              className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            />
            <FieldError id="field-translation-body-error" message={addState.fieldErrors?.body} />
          </div>
          <FieldError id="translation-error" message={addState.error} />
          <LiveRegion>
            {addState.notice && <p className="text-sm">{addState.notice}</p>}
          </LiveRegion>
          <button
            type="submit"
            disabled={addPending}
            className="bg-foreground text-background min-h-11 self-start rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
          >
            Save translation
          </button>
        </form>
      </details>

      <form action={retireFormAction} className="flex flex-col gap-2 border-t pt-4">
        <p className="text-muted-foreground text-sm">
          {/* Retired, never deleted — a message sent from a template is
              evidence, and the template is part of explaining it. */}
          {active
            ? 'Retiring a template hides it from the picker. It is kept, because messages already sent from it refer to it.'
            : 'This template is retired and does not appear in the picker.'}
        </p>
        <FieldError id="retire-error" message={retireState.error} />
        <LiveRegion>
          {retireState.notice && <p className="text-sm">{retireState.notice}</p>}
        </LiveRegion>
        <button
          type="submit"
          disabled={retirePending}
          className="border-input min-h-11 self-start rounded-md border px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
        >
          {active ? 'Retire this template' : 'Put it back in use'}
        </button>
      </form>
    </section>
  )
}
