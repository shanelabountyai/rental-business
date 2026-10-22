'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextareaField } from '@/components/form/field.tsx'
import type { NoteFormState } from '@/lib/applications/staff-actions.ts'

// R-271 (PRD 08 C2): the reviewer's mobile surface for one applicant.

/// Swipeable on a phone (scroll-snap), a plain scrolling row on desktop.
/// Images render inline; anything else is a link, because the serving route
/// retypes what cannot execute and the browser's own viewer handles a PDF.
export function DocumentStrip({
  documents,
  applicantName,
}: {
  documents: readonly { id: string; fileName: string; contentType: string }[]
  applicantName: string
}) {
  if (documents.length === 0) {
    return <p className="text-muted-foreground text-sm">No documents uploaded.</p>
  }
  return (
    <ul
      aria-label={`Documents from ${applicantName}`}
      className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2"
    >
      {documents.map((d) => {
        const href = `/api/documents/${d.id}/file`
        return (
          <li key={d.id} className="w-64 max-w-[80%] shrink-0 snap-start rounded border p-2">
            {d.contentType.startsWith('image/') && (
              // eslint-disable-next-line @next/next/no-img-element -- staff-scoped file route, not an optimizable asset
              <img
                src={href}
                alt={`${d.fileName} from ${applicantName}`}
                className="mb-2 h-40 w-full rounded object-contain"
              />
            )}
            <a href={href} className="text-sm break-words underline underline-offset-2">
              {d.fileName}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

export function ApplicantNoteForm({
  action,
  applicantId,
  applicantName,
}: {
  action: (state: NoteFormState, formData: FormData) => Promise<NoteFormState>
  applicantId: string
  applicantName: string
}) {
  const [state, formAction] = useActionState<NoteFormState, FormData>(action, {})
  return (
    <form action={formAction} className="rounded border p-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Internal note about {applicantName}</legend>
        <input type="hidden" name="applicantId" value={applicantId} />
        <FormAlerts state={state} />
        <TextareaField
          label="Internal note"
          name="body"
          idPrefix={`note-${applicantId}`}
          hint="Staff only. Never sent to the applicant."
          rows={2}
        />
        <SubmitButton
          label={
            <>
              Save note<span className="sr-only"> about {applicantName}</span>
            </>
          }
        />
      </fieldset>
    </form>
  )
}
