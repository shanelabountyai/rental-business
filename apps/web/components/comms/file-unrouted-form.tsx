'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/comms/actions.ts'

// The human half of the routing decision.
//
// The engine refused to guess who this came from (see
// packages/core/comms/threads.ts). This is where a person takes
// responsibility for the association - which is why the tenant is chosen
// explicitly from a list rather than pre-selected as a "best guess" the
// operator would click straight past.
export function FileUnroutedForm({
  action,
  rowId,
  tenants,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  /// Disambiguates the field id when several of these forms are on the page
  /// at once - the duplicate-id bug class R-014 fixed generically.
  rowId: string
  tenants: readonly { id: string; label: string }[]
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <FormAlerts state={state} />
      <div className="min-w-56">
        <SelectField
          label="This is from"
          name="tenantId"
          idPrefix={`unrouted-${rowId}`}
          required
          placeholder="Choose a tenant…"
          options={tenants.map((tenant) => ({
            value: tenant.id,
            label: tenant.label,
          }))}
        />
      </div>
      <SubmitButton label="File it" />
    </form>
  )
}
