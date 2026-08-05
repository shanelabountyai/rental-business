'use client'

import { useActionState } from 'react'
import { FormAlerts } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/operational/actions.ts'

export function DeleteRowButton({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <FormAlerts state={state} />
      <button
        type="submit"
        className="text-muted-foreground hover:text-red-700 min-h-9 rounded-md px-2 text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:hover:text-red-400"
      >
        Remove
      </button>
    </form>
  )
}
