'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { StaffFormState } from '@/lib/staff/actions.ts'
import { SetupLink } from './setup-link.tsx'

export function InviteStaffForm({
  action,
  roleOptions,
  scopeOptions,
}: {
  action: (state: StaffFormState, formData: FormData) => Promise<StaffFormState>
  roleOptions: readonly { value: string; label: string }[]
  scopeOptions: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<StaffFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {/* Mounted above everything the action can change, and never keyed:
          a `key` on the form throws these regions away on every response,
          which is R-102's trap and silently undoes R-101's fix. */}
      <FormAlerts state={state} />
      <SetupLink url={state.setupUrl} />
      <TextField label="Full name" name="name" required error={errors.name} />
      <TextField label="Email address" name="email" type="email" required error={errors.email} />
      <SelectField
        label="Role"
        name="roleKey"
        required
        options={roleOptions}
        error={errors.roleKey}
      />
      <SelectField
        label="Access scope"
        name="scope"
        required
        defaultValue="all"
        options={scopeOptions}
        error={errors.scope}
      />
      <SubmitButton label="Create account and send setup link" />
    </form>
  )
}
