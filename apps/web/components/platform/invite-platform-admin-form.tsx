'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import { SetupLink } from '@/components/staff/setup-link.tsx'
import type { PlatformAdminFormState } from '@/lib/platform/admin-actions.ts'

// `/platform/admins/new` (PRD 11 §4.8, R-302b). The org's staff invite form,
// without a scope: a platform role has none.
export function InvitePlatformAdminForm({
  action,
  roleOptions,
}: {
  action: (state: PlatformAdminFormState, formData: FormData) => Promise<PlatformAdminFormState>
  roleOptions: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<PlatformAdminFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <SetupLink url={state.setupUrl} />
      <TextField label="Full name" name="name" required error={errors.name} />
      <TextField label="Email address" name="email" type="email" required error={errors.email} />
      <SelectField label="Platform role" name="roleKey" required options={roleOptions} error={errors.roleKey} />
      <SubmitButton label="Invite and send setup link" />
    </form>
  )
}
