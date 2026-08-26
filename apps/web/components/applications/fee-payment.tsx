'use client'

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { type Stripe, loadStripe } from '@stripe/stripe-js'
import { useState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import type { FeePaymentState } from '@/lib/applications/actions.ts'

// The application fee (LEASE-03, R-059) - same Stripe-hosted-fields shape
// as AutopayPanel (§6.6): a card or bank number is typed into Stripe's own
// iframe and never reaches this document. The fee is confirmed WEBHOOK-SIDE
// (`applicant.feePaidAt`, D-11's rule), not by this component - a closed
// browser tab must not leave a paid applicant looking unpaid.
//
// NOT COVERED BY THE E2E SUITE, for the identical reason AutopayPanel's own
// header states: Elements is a cross-origin iframe Playwright cannot drive
// without brittle same-origin assumptions. e2e/applications.spec.ts proves
// the server half (the intent, the webhook, `completeApplicantIfDone`) by
// simulating the webhook event directly.

let stripePromise: Promise<Stripe | null> | null = null
function stripe(publishableKey: string) {
  stripePromise ??= loadStripe(publishableKey)
  return stripePromise
}

function ConfirmForm({ onDone }: { onDone: () => void }) {
  const stripeApi = useStripe()
  const elements = useElements()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!stripeApi || !elements) return
        setBusy(true)
        setError(null)

        const result = await stripeApi.confirmPayment({
          elements,
          confirmParams: { return_url: `${window.location.href}?fee=paid` },
          redirect: 'if_required',
        })

        setBusy(false)
        if (result.error) {
          setError(result.error.message ?? 'That did not work. Please try again.')
          return
        }
        onDone()
      }}
    >
      <PaymentElement />

      <LiveRegion assertive>
        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900">
            {error}
          </p>
        )}
      </LiveRegion>

      <button
        type="submit"
        disabled={busy || !stripeApi}
        className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        {busy ? 'Paying…' : 'Pay application fee'}
      </button>
    </form>
  )
}

export function FeePayment({
  publishableKey,
  start,
}: {
  publishableKey: string | null
  start: () => Promise<FeePaymentState>
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!publishableKey) return null

  // Both regions stay mounted across the whole flow - the confirmation used
  // to be an early `return`, which replaced the form with an already-populated
  // `role="status"` and announced nothing to the applicant who had just paid
  // (R-101's defect, R-107b's sweep).
  return (
    <div className="flex flex-col gap-3">
      <LiveRegion assertive>
        {error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900">
            {error}
          </p>
        )}
      </LiveRegion>
      <LiveRegion>
        {submitted && (
          <p className="text-base">
            Payment submitted - this page will update once it clears.
          </p>
        )}
      </LiveRegion>

      {submitted ? null : clientSecret ? (
        <Elements
          stripe={stripe(publishableKey)}
          options={{ clientSecret, appearance: { theme: 'stripe' } }}
        >
          <ConfirmForm onDone={() => setSubmitted(true)} />
        </Elements>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            const result = await start()
            setBusy(false)
            if (result.error || !result.clientSecret) {
              setError(result.error ?? 'That did not work. Please try again.')
              return
            }
            setClientSecret(result.clientSecret)
          }}
          className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md border px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 sm:w-auto"
        >
          {busy ? 'Getting ready…' : 'Pay application fee'}
        </button>
      )}
    </div>
  )
}
