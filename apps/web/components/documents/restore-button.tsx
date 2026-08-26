'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/documents/actions.ts'

/// `fileName` in the label for the same reason `DeleteForm` carries it: the
/// "Recently deleted" list renders one of these per document and every one of
/// them said "Restore" (R-115).
export function RestoreButton({
  action,
  fileName,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  fileName: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex items-center gap-2">
      <FormAlerts state={state} />
      <SubmitButton
        label={
          <>
            Restore<span className="sr-only"> {fileName}</span>
          </>
        }
      />
    </form>
  )
}
