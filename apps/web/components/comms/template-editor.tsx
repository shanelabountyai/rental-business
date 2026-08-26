'use client'

import { useActionState, useState } from 'react'
import { MERGE_FIELDS, renderTemplate } from '@rental/core/comms'
import { LiveRegion, pendingButtonProps } from '@/components/auth-form.tsx'
import { FieldError, TextField } from '@/components/form/field.tsx'
import type { TemplateFormState } from '@/lib/comms/template-actions.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// Writing a template, and seeing what a tenant will get (COMM-03, R-049).
//
// ==========================================================================
// THE PREVIEW IS LIVE AND IT USES REAL DATA.
//
// Both halves matter. Live, because a preview behind a button is a preview
// nobody presses — and the failure this screen exists to catch (a merge field
// that comes out blank) is invisible until something renders it.
//
// Real data, because the catalogue's example values would make every preview
// look perfect. A PM needs to see `{{lease.ends_on}}` come out EMPTY on their
// month-to-month tenancies before they send to four hundred of them, not
// after.
//
// The values are resolved on the SERVER by the same `templateValues()` the
// send path uses and passed down here — the client does no lookups and no
// money formatting. A preview built from different code than the send is not
// a preview; it is a second implementation that agrees until it does not.
// ==========================================================================

export function TemplateEditor({
  defaults,
  sampleValues,
  sampleLabel,
  saveAction,
}: {
  defaults: { name: string; kind: string; subject: string; body: string }
  /// Resolved server-side from a real tenancy. Empty when the portfolio has
  /// no live lease to preview against yet.
  sampleValues: Record<string, string | null>
  sampleLabel: string | null
  saveAction: (
    previous: TemplateFormState,
    formData: FormData,
  ) => Promise<TemplateFormState>
}) {
  const [state, action, pending] = useActionState<TemplateFormState, FormData>(
    saveAction,
    {},
  )
  const [subject, setSubject] = useState(defaults.subject)
  const [body, setBody] = useState(defaults.body)

  const renderedBody = renderTemplate(body, sampleValues)
  const renderedSubject = subject ? renderTemplate(subject, sampleValues) : null
  const missing = [...new Set([...renderedBody.missing, ...(renderedSubject?.missing ?? [])])]

  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-4">
        <TextField
          label="Template name"
          name="name"
          required
          defaultValue={defaults.name}
          error={state.fieldErrors?.name}
          hint="What you will look for in the list. “Late rent — first reminder”, not “Template 3”."
          idPrefix="tpl"
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">What is this for?</legend>
          <p className="text-muted-foreground text-sm">
            {/* The consequence, not the label. Somebody choosing between two
                radio buttons needs to know what changes, and what changes here
                is whether a translation can be used without sign-off. */}
            A legal notice may only go out in a language somebody has approved.
            A routine message can use any translation you have.
          </p>
          {[
            { value: 'ROUTINE', label: 'Routine message' },
            { value: 'LEGAL', label: 'Legal notice' },
          ].map((option) => (
            <label key={option.value} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                value={option.value}
                defaultChecked={defaults.kind === option.value}
                className="size-5"
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        <TextField
          label="Subject line (email only)"
          name="subject"
          required={false}
          defaultValue={defaults.subject}
          error={state.fieldErrors?.subject}
          hint="Leave blank for a text-message template."
          idPrefix="tpl"
          onChange={setSubject}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="tpl-body" className="text-sm font-medium">
            Message
          </label>
          <textarea
            id="tpl-body"
            name="body"
            required
            rows={10}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-invalid={state.fieldErrors?.body ? true : undefined}
            aria-describedby={state.fieldErrors?.body ? 'tpl-body-error' : undefined}
            className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
          <FieldError id="tpl-body-error" message={state.fieldErrors?.body} />
        </div>

        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer">
            Merge fields you can use ({MERGE_FIELDS.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {MERGE_FIELDS.map((field) => (
              <li key={field.key} className="text-muted-foreground">
                <code>{`{{${field.key}}}`}</code> — {field.label}
              </li>
            ))}
          </ul>
        </details>

        <FieldError id="tpl-error" message={state.error} />
        <LiveRegion>{state.notice && <p className="text-sm">{state.notice}</p>}</LiveRegion>

        <button
          type="submit"
          {...pendingButtonProps(pending)}
          className={`${PRIMARY_BUTTON_CLASSES} self-start`}
        >
          Save template
        </button>
      </form>

      <section aria-labelledby="preview" className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 id="preview" className="text-sm font-medium">
          What {sampleLabel ?? 'a tenant'} would get
        </h2>

        {sampleLabel == null ? (
          <p className="text-muted-foreground text-sm">
            There is no live tenancy to preview against yet, so this shows the
            template as written.
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            Rendered against a real tenancy, so a field with nothing behind it
            shows up here rather than in somebody&rsquo;s inbox.
          </p>
        )}

        {/* Announces when it changes rather than on arrival — the region is
            always in the tree (R-101). A PM typing a merge field wants to
            know it resolved without leaving the textarea. */}
        <LiveRegion>
          {missing.length > 0 && (
            <p className="rounded-md border border-amber-300 px-3 py-2 text-sm">
              {/* NAMES THE FIELDS. This is the whole reason the preview is
                  here, and "some fields are empty" would send somebody
                  hunting through their own paragraph. */}
              Nothing to put in {missing.map((key) => `{{${key}}}`).join(', ')} for
              this tenant. Sending would leave that showing.
            </p>
          )}
        </LiveRegion>

        {renderedSubject && (
          <p className="text-sm font-medium">{renderedSubject.text}</p>
        )}
        <p className="text-sm whitespace-pre-wrap">{renderedBody.text || '—'}</p>
      </section>
    </div>
  )
}
