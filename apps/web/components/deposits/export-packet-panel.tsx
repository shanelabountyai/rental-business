'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { DepositFormState } from '@/lib/deposits/actions.ts'

type Action = (state: DepositFormState, formData: FormData) => Promise<DepositFormState>

/// The deposit-dispute packet (R-218). One button, like R-083's attorney
/// packet, and a returned summary, because the export names any exhibit it
/// could not attach (D-50) and that sentence has to reach the screen.
///
/// On the LEASE page, not `/leases/[id]/deposit`: a disposition that refunded
/// nothing redirects away from that page, and a deposit kept in full is the
/// likeliest one to be disputed.
export function ExportDepositPacketPanel({ action }: { action: Action }) {
  const [state, formAction] = useActionState<DepositFormState, FormData>(action, {})

  return (
    <form action={formAction} className="mt-2 flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label="Produce deposit dispute packet" />
    </form>
  )
}
