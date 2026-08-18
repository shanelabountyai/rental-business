'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField, TextField } from '@/components/form/field.tsx'
import { DOCUMENT_MERGE_FIELDS } from '@rental/core/documents'
import type { DocumentTemplateFormState } from '@/lib/documents/template-actions.ts'

// Authoring a document template (DOC-04, R-062) - deliberately simpler than
// MessageTemplate's own editor (no live preview, no translations): a
// generated letter has one language and one recipient at a time, and the
// merge-field list below is the same "pick from the closed catalogue" help
// `comms/template-editor.tsx` gives, just without the client-side render.

export function DocumentTemplateForm({
  action,
  documentTypeOptions,
  defaults,
}: {
  action: (
    state: DocumentTemplateFormState,
    formData: FormData,
  ) => Promise<DocumentTemplateFormState>
  documentTypeOptions: readonly { value: string; label: string }[]
  defaults: { name: string; documentType: string; body: string }
}) {
  const [state, formAction] = useActionState<DocumentTemplateFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-md border p-4">
      <FormAlerts state={state} />
      <TextField
        label="Name"
        name="name"
        idPrefix="doctemplate"
        required
        defaultValue={defaults.name}
        error={errors.name}
      />
      <SelectField
        label="Generates a"
        name="documentType"
        idPrefix="doctemplate"
        required
        defaultValue={defaults.documentType}
        options={documentTypeOptions}
        error={errors.documentType}
      />
      <TextareaField
        label="Body"
        name="body"
        idPrefix="doctemplate"
        required
        defaultValue={defaults.body}
        rows={10}
        error={errors.body}
        hint={`Merge fields: ${DOCUMENT_MERGE_FIELDS.map((f) => `{{${f.key}}}`).join(', ')}`}
      />
      <SubmitButton label="Save" />
    </form>
  )
}
