'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/comms/transcript.ts'

// COMM-05 (R-052): "any thread exports as a timestamped PDF transcript with
// delivery metadata (court/adjuster packet)."
//
// A REAL `<form action>`, not a button with an onClick - producing a document
// must work on first paint, before hydration, which a click handler does not.
// The repo has been bitten by that distinction before and it is a standing
// rule, not a preference.
export function ExportTranscriptForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <p className="text-muted-foreground text-sm">
        Produces a PDF of every message, automated notification and served
        notice on this party&rsquo;s record at this property, with the delivery
        status of each. Each export is archived separately, so a transcript
        produced today stays retrievable after the conversation moves on.
      </p>
      <SubmitButton label="Produce transcript" />
      {state.documentId && (
        <Link
          href={`/api/documents/${state.documentId}/file`}
          className="focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Open the transcript
        </Link>
      )}
    </form>
  )
}
