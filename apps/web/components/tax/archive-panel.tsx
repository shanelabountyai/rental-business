'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { ArchiveState } from '@/lib/tax/archive.ts'

// The archive button (RPT-07, R-081d).
//
// A real `<form action>` rather than a button with a handler: this writes a
// Document and an audit row, and `onClick` is inert until hydration. The
// entity, year and basis travel as hidden fields so the archived packet is the
// one on screen, not whatever the action would default to.
//
// The returned summary reaches the screen because the export names any 1098 it
// could not attach (D-50), and that sentence is the whole point of saying it.

export function ArchivePacketPanel({
  action,
  entityId,
  year,
  basis,
}: {
  action: (state: ArchiveState, formData: FormData) => Promise<ArchiveState>
  entityId: string
  year: number
  basis: string
}) {
  const [state, formAction] = useActionState<ArchiveState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <input type="hidden" name="entity" value={entityId} />
      <input type="hidden" name="year" value={year} />
      <input type="hidden" name="basis" value={basis} />
      <SubmitButton label="Archive packet as PDF" />
      {state.documentId && (
        <a
          href={`/api/documents/${state.documentId}/file`}
          className="focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Open the archived packet
        </a>
      )}
    </form>
  )
}
