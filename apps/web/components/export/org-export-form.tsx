'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { OrgExportFormState } from '@/lib/export/actions.ts'

// `/settings/export` (R-299). The result region sits outside the form so a
// re-render cannot take its own notice off the screen (CLAUDE.md).

type Action = (state: OrgExportFormState, formData: FormData) => Promise<OrgExportFormState>

export function OrgExportForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState<OrgExportFormState, FormData>(action, {})
  return (
    <div className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <form action={formAction} className="flex max-w-sm flex-col gap-3">
        <TextField
          label="Your authenticator code to export"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          error={state.fieldErrors?.code}
          idPrefix="org-export"
        />
        <SubmitButton label="Export all organisation data" />
      </form>
    </div>
  )
}

/// R-300a: the owner's own freeze. Its own form and result region, below the
/// export, so the export's notice and this one can never be confused.
export function OrgFreezeForm({ action, slug }: { action: Action; slug: string }) {
  const [state, formAction] = useActionState<OrgExportFormState, FormData>(action, {})
  return (
    <div className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <form action={formAction} className="flex max-w-sm flex-col gap-3">
        <TextField
          label={`Type ${slug} to confirm the freeze`}
          name="confirmFreeze"
          required
          autoComplete="off"
          error={state.fieldErrors?.confirmFreeze}
          idPrefix="org-freeze"
        />
        <TextField
          label="Your authenticator code to freeze"
          name="freezeCode"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          error={state.fieldErrors?.freezeCode}
          idPrefix="org-freeze"
        />
        <SubmitButton label="Freeze this organisation" />
      </form>
    </div>
  )
}
