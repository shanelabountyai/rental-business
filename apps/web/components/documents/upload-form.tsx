'use client'

import { DOCUMENT_TYPES } from '@rental/core/documents'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/documents/actions.ts'

const TYPE_LABELS: Record<string, string> = {
  LEASE: 'Lease',
  ADDENDUM: 'Addendum',
  NOTICE: 'Notice',
  INVOICE: 'Invoice',
  INSURANCE_COI: 'Insurance (COI)',
  W9: 'W-9',
  INSPECTION_REPORT: 'Inspection report',
  UNIT_PHOTO: 'Unit photo',
  PROPERTY_PHOTO: 'Property photo',
  SHUTOFF_PHOTO: 'Shutoff photo',
  SCREENING_REPORT: 'Screening report',
  APPLICATION: 'Application',
  OTHER: 'Other',
}

export function UploadForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <FormAlerts state={state} />
      <div className="min-w-40">
        <SelectField
          label="Type"
          name="type"
          idPrefix="doc"
          required
          error={errors.type}
          options={DOCUMENT_TYPES.map((type) => ({
            value: type,
            label: TYPE_LABELS[type] ?? type,
          }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-file" className="text-sm font-medium">
          File
        </label>
        <input
          id="field-file"
          name="file"
          type="file"
          required
          aria-invalid={Boolean(errors.file) || undefined}
          className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
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
