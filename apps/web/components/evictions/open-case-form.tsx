'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import { RetaliationAck } from '@/components/leases/retaliation-ack.tsx'
import type { EvictionFormState } from '@/lib/evictions/actions.ts'

export function OpenCaseForm({
  action,
  leases,
}: {
  action: (state: EvictionFormState, formData: FormData) => Promise<EvictionFormState>
  leases: readonly { value: string; label: string }[]
}) {
  const [state, formAction] = useActionState<EvictionFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const echoed = state.values ?? {}

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Tenancy"
        name="leaseId"
        required
        options={leases}
        defaultValue={echoed.leaseId}
        key={`lease-${echoed.leaseId ?? ''}`}
      />
      <TextField
        label="Why is this case being opened?"
        name="reason"
        required
        defaultValue={echoed.reason}
        key={`reason-${echoed.reason ?? ''}`}
        error={errors.reason}
        hint="The delinquency this rests on, in the owner's own words. This goes on the permanent audit record and is what a retaliation claim is answered from."
      />
      <RetaliationAck
        view={state.needsRetaliationAck}
        label="Why open a case now, inside the window?"
        defending="case"
        idPrefix="case"
        defaultValue={echoed.retaliationReason}
        error={errors.retaliationReason}
      />
      <SubmitButton label={state.needsRetaliationAck ? 'Open case anyway, with this reason' : 'Open case'} />
    </form>
  )
}
