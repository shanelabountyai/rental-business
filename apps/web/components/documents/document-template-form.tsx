'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField, TextField } from '@/components/form/field.tsx'
import { DOCUMENT_MERGE_FIELDS } from '@rental/core/documents'
import { ADDENDUM_KEYS, ADDENDUM_LABELS, LEASE_MERGE_FIELDS } from '@rental/core/leases'
import { US_STATE_OPTIONS } from '@rental/core/property'
import type { DocumentTemplateFormState } from '@/lib/documents/template-actions.ts'

// Authoring a document template (DOC-04, R-062; state/addendumKey added by
// R-063) - deliberately simpler than MessageTemplate's own editor (no live
// preview, no translations): a generated letter has one language and one
// recipient at a time, and the merge-field list below is the same "pick from
// the closed catalogue" help `comms/template-editor.tsx` gives, just without
// the client-side render.

const ADDENDUM_KEY_OPTIONS = ADDENDUM_KEYS.map((key) => ({ value: key, label: ADDENDUM_LABELS[key] }))
const STATE_OPTIONS = [
  { value: '', label: 'Any state (default)' },
  ...US_STATE_OPTIONS.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` })),
]

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
  defaults: { name: string; documentType: string; body: string; state?: string; addendumKey?: string }
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
      <SelectField
        label="State"
        name="state"
        idPrefix="doctemplate"
        defaultValue={defaults.state ?? ''}
        options={STATE_OPTIONS}
        error={errors.state}
      />
      <SelectField
        label="Addendum trigger (only for an ADDENDUM template)"
        name="addendumKey"
        idPrefix="doctemplate"
        defaultValue={defaults.addendumKey ?? ''}
        options={[{ value: '', label: 'Not an addendum' }, ...ADDENDUM_KEY_OPTIONS]}
        error={errors.addendumKey}
      />
      <TextareaField
        label="Body"
        name="body"
        idPrefix="doctemplate"
        required
        defaultValue={defaults.body}
        rows={10}
        error={errors.body}
        hint={`For a letter or estoppel certificate: ${DOCUMENT_MERGE_FIELDS.map((f) => `{{${f.key}}}`).join(', ')}. For a lease or addendum: ${LEASE_MERGE_FIELDS.map((f) => `{{${f.key}}}`).join(', ')}.`}
      />
      <SubmitButton label="Save" />
    </form>
  )
}
