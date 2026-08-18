'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { GenerateFormState } from '@/lib/documents/generate.ts'

// Generating one document from a template (DOC-04, R-062) - property and
// recipient are the two facts nothing on the template itself can supply,
// since the same letter template is reused for different people.

export function GenerateDocumentForm({
  action,
  properties,
}: {
  action: (state: GenerateFormState, formData: FormData) => Promise<GenerateFormState>
  properties: readonly { id: string; name: string }[]
}) {
  const [state, formAction] = useActionState<GenerateFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-md border p-3">
      <FormAlerts state={state} />
      <SelectField
        label="Property"
        name="propertyId"
        idPrefix="generate"
        required
        options={properties.map((p) => ({ value: p.id, label: p.name }))}
        error={errors.propertyId}
      />
      <TextField
        label="Recipient name"
        name="recipientName"
        idPrefix="generate"
        required
        error={errors.recipientName}
      />
      <SubmitButton label="Generate" />
      {state.documentId && (
        <p className="text-sm">
          <a
            href={`/api/documents/${state.documentId}/file`}
            className="underline underline-offset-4"
          >
            Download the generated PDF
          </a>
        </p>
      )}
    </form>
  )
}
