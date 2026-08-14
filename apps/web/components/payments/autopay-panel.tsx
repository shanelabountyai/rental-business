'use client'

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { type Stripe, loadStripe } from '@stripe/stripe-js'
import { useState } from 'react'
import type { AutopaySetupState } from '@/lib/payments/autopay-actions.ts'

// Turning autopay on (PAY-02, R-039a).
//
// THE ONLY PART OF THIS PRODUCT THAT LOADS THIRD-PARTY CODE, and it does so
// lazily - `loadStripe` is called on first use rather than at module scope,
// so a tenant who never touches autopay never fetches Stripe's script. That
// matters on the portal, which is mobile-first and read by people on
// whatever connection they have (§6.5).
//
// Card and bank numbers are typed into Stripe's own iframe and never enter
// this document (§6.6). We hand Elements a client secret and get back a
// confirmation; the ENROLMENT itself is learned from the
// `setup_intent.succeeded` webhook, because the browser can be closed the
// instant after confirm and a tenant who did everything right must not lose
// autopay because their phone slept.
//
// NOT COVERED BY THE E2E SUITE, and D-15 said so in advance: Elements is a
// cross-origin iframe that Playwright cannot drive without brittle
// same-origin assumptions. The server half - the action, the webhook, the
// collection switch - is tested. This component is hand-verified against a
// test key, and PROGRESS says so rather than implying coverage.

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

        const result = await stripeApi.confirmSetup({
          elements,
          confirmParams: {
            // Stays on the portal. `if_required` means a card that needs no
            // 3DS challenge never leaves the page at all; one that does gets
            // sent here and back.
            return_url: `${window.location.origin}/portal/pay?autopay=saved`,
          },
          redirect: 'if_required',
        })

        setBusy(false)
        if (result.error) {
          // Stripe's message, not ours. It knows why a card was declined and
          // we do not, and inventing a friendlier sentence would tell the
          // tenant something less true.
          setError(result.error.message ?? 'That did not work. Please try again.')
          return
        }
        onDone()
      }}
    >
      <PaymentElement />

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !stripeApi}
        className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        {busy ? 'Saving…' : 'Save and turn on automatic payments'}
      </button>
    </form>
  )
}

export function AutopayPanel({
  publishableKey,
  alreadyOn,
  start,
}: {
  publishableKey: string | null
  /// True when a payment method is already on file and the payer is on
  /// automatic collection.
  alreadyOn: boolean
  start: () => Promise<AutopaySetupState>
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // Nothing to offer without a publishable key. Rendering a button that
  // cannot work is worse than rendering nothing - the same call the vendor
  // help line makes when its number is unset (R-098).
  if (!publishableKey) return null

  if (alreadyOn || saved) {
    return (
      <section aria-labelledby="autopay" className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 id="autopay" className="text-base font-medium">
          Automatic payments are on
        </h2>
        {/* `role="status"` only announces a MUTATION, so this is only a live
            region when it has just changed - S2's rule, applied rather than
            copied. Rendered plain when the page loads with autopay already
            on, because nothing changed and there is nothing to announce. */}
        <p className="text-base" {...(saved ? { role: 'status' as const } : {})}>
          Rent will be collected automatically on the day it is due. You will
          still get a message before every payment, and you can turn this off
          by contacting the office.
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="autopay" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="autopay" className="text-base font-medium">
        Turn on automatic payments
      </h2>
      <p className="text-base">
        Rent gets paid on time without you having to remember. Your card or
        bank details are held by our payment provider, never by us.
      </p>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-base text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </p>
      )}

      {clientSecret ? (
        <Elements
          stripe={stripe(publishableKey)}
          options={{ clientSecret, appearance: { theme: 'stripe' } }}
        >
          <ConfirmForm onDone={() => setSaved(true)} />
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
          className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 w-full items-center justify-center rounded-md border px-6 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 sm:w-auto"
        >
          {busy ? 'Getting ready…' : 'Set up automatic payments'}
        </button>
      )}
    </section>
  )
}
