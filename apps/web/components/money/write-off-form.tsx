'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextareaField } from '@/components/form/field.tsx'
import type { WriteOffFormState } from '@/lib/payments/write-off-actions.ts'

// R-215. A write-off is a decision somebody signs, so it asks for the reason
// and nothing else - the amount is read on the server from what is owed on
// the day. Inside a native <details>, which works before hydration and keeps
// a row's one irreversible act a deliberate second click away.
//
// Every label carries the tenant's name: one of these renders per row, and
// two controls on a page must never share an accessible name.
export function WriteOffForm({
  action,
  tenantName,
  idPrefix,
}: {
  action: (state: WriteOffFormState, formData: FormData) => Promise<WriteOffFormState>
  tenantName: string
  idPrefix: string
}) {
  const [state, formAction] = useActionState<WriteOffFormState, FormData>(action, {})
  return (
    <details className="mt-1">
      <summary className="text-muted-foreground min-h-11 cursor-pointer py-2 text-xs underline underline-offset-2">
        Write off<span className="sr-only"> what {tenantName} owes</span>
      </summary>
      <form action={formAction} className="flex flex-col gap-2 pt-2">
        <FormAlerts state={state} />
        <TextareaField
          label={`Why ${tenantName}'s balance is being written off`}
          name="reason"
          idPrefix={idPrefix}
          required
          rows={2}
          error={state.fieldErrors?.reason}
          hint="The debt stays owed. This records that you have stopped pursuing it."
        />
        <SubmitButton label={<>Write off<span className="sr-only"> {tenantName}&apos;s balance</span></>} />
      </form>
    </details>
  )
}
