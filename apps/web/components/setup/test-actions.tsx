'use client'

import { useActionState } from 'react'
import { Field, FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { ConnectStripeForm } from '@/components/billing/connect-stripe-form.tsx'
import type { SetupFormState } from '@/lib/setup/actions.ts'

type Action = (state: SetupFormState, formData: FormData) => Promise<SetupFormState>

// Step 9's two presses (R-291b, PRD 10 §5). Each form keeps its own result
// region mounted outside anything that remounts. The $1 opens Stripe's hosted
// invoice page as a full navigation, as onboarding does (D-379).
export function SetupTestActions({
  sendText,
  billDollar,
  phone,
}: {
  sendText: Action
  billDollar: Action
  phone: string | null
}) {
  const [state, formAction] = useActionState(sendText, {})
  return (
    <section aria-labelledby="test-heading" className="flex flex-col gap-4 rounded-md border p-4 text-sm">
      <h2 id="test-heading" className="text-lg font-semibold">
        Test text and test payment
      </h2>
      <form action={formAction} className="flex flex-col gap-3">
        <FormAlerts state={state} />
        <Field label="Your mobile number" name="phone" type="tel" autoComplete="tel" defaultValue={phone ?? ''} />
        <div>
          <SubmitButton label="Send a test text" />
        </div>
      </form>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">Bills you $1 on your connected Stripe account. Pay it on Stripe&apos;s page.</p>
        <ConnectStripeForm action={billDollar} label="Bill me $1" />
      </div>
    </section>
  )
}
