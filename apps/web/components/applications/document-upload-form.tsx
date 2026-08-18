'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { ApplicantFormState } from '@/lib/applications/actions.ts'

// An ID scan or an income document (LEASE-03, R-059). One file per submit -
// a household with several months of pay stubs uploads them one at a time,
// each its own Document row, rather than a multi-file picker whose partial
// failure (one of five files too large) is harder to explain to a screen
// reader than "choose a file" repeated five times.

export function DocumentUploadForm({
  action,
}: {
  action: (state: ApplicantFormState, formData: FormData) => Promise<ApplicantFormState>
}) {
  const [state, formAction] = useActionState<ApplicantFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="applicant-upload-file" className="text-sm font-medium">
          Upload a photo ID or an income document
        </label>
        <input
          id="applicant-upload-file"
          name="file"
          type="file"
          required
          aria-invalid={Boolean(errors.file) || undefined}
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        />
        {errors.file && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {errors.file}
          </p>
        )}
      </div>
      <SubmitButton label="Upload" />
    </form>
  )
}
