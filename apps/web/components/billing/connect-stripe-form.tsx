'use client'

import { useActionState, useEffect } from 'react'
import { FormAlerts, SubmitButton, pendingButtonProps } from '@/components/auth-form.tsx'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import type { StripeFormState } from '@/lib/integrations/stripe-actions.ts'

type Action = (state: StripeFormState, formData: FormData) => Promise<StripeFormState>

/// R-277b: the action answers with Stripe's page (or the way back from it),
/// and the browser opens it as a full navigation, as it would Stripe's.
export function useOpening(action: Action) {
  const [state, formAction, pending] = useActionState(action, {})
  useEffect(() => {
    if (state.openUrl) window.location.assign(state.openUrl)
  }, [state])
  return { state, formAction, pending }
}

/// One button into Stripe's hosted onboarding.
export function ConnectStripeForm({ action, label }: { action: Action; label: string }) {
  const { state, formAction } = useOpening(action)
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <div>
        <SubmitButton label={label} />
      </div>
    </form>
  )
}

/// The simulated hosted page's two answers (D-27).
export function SimulatedOnboardingForm({ action }: { action: Action }) {
  const { state, formAction, pending } = useOpening(action)
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <div className="flex flex-wrap gap-3">
        <button type="submit" name="outcome" value="complete" {...pendingButtonProps(pending)} className={`${PRIMARY_BUTTON_CLASSES} min-h-11 px-4`}>
          Finish onboarding
        </button>
        <button type="submit" name="outcome" value="restricted" {...pendingButtonProps(pending)} className={`${PRIMARY_BUTTON_CLASSES} min-h-11 px-4`}>
          Submit without a bank account
        </button>
      </div>
    </form>
  )
}
