'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { BillingFormState } from '@/lib/billing/actions.ts'

// PAY-12's legal-action payment controls (R-047).
//
// ==========================================================================
// ITS OWN SECTION, NOT A ROW IN THE BILLING PANEL. Two reasons.
//
// The permission differs: billing re-sync runs on `ledger.read` because
// whoever can see a lease's money should be able to fix its billing, while
// this stops taking somebody's rent in support of an eviction and runs on
// `ledger.adjust` with a proved second factor.
//
// And a hold has to be VISIBLE. A control buried in a list is one nobody
// notices is still on six weeks after the case settled — and a tenancy whose
// payments are silently blocked accrues arrears it was never given the
// chance to clear.
// ==========================================================================

export interface PayerHoldView {
  id: string
  name: string
  blockOnline: boolean
  blockPartial: boolean
  certifiedFundsOnly: boolean
  reason: string | null
  setAt: string | null
  setByName: string | null
}

function HoldForm({
  payer,
  action,
}: {
  payer: PayerHoldView
  action: (state: BillingFormState, formData: FormData) => Promise<BillingFormState>
}) {
  const [state, formAction] = useActionState<BillingFormState, FormData>(action, {})
  const [blockOnline, setBlockOnline] = useState(payer.blockOnline)
  const [blockPartial, setBlockPartial] = useState(payer.blockPartial)
  const [certifiedFundsOnly, setCertifiedFundsOnly] = useState(payer.certifiedFundsOnly)

  const held = blockOnline || blockPartial || certifiedFundsOnly

  return (
    <form action={formAction} className="flex flex-col gap-3 py-3">
      <input type="hidden" name="leasePayerId" value={payer.id} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{payer.name}</span>
        {payer.setAt && (
          // WHEN AND BY WHOM, on the screen rather than only in the audit
          // log. A hold nobody can attribute is one nobody will lift.
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            Held since {payer.setAt}
            {payer.setByName ? ` by ${payer.setByName}` : ''}
          </span>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Payment controls for {payer.name}</legend>

        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="blockOnline"
            className="mt-1 size-5"
            checked={blockOnline}
            onChange={(event) => setBlockOnline(event.target.checked)}
          />
          <span>
            <span className="font-medium">Block online payments</span>
            <span className="text-muted-foreground block text-xs">
              Pauses the Stripe subscription and closes the payment screen.
              Live pay-now links are revoked. Staff can still record a payment
              that arrives by post or in person.
            </span>
          </span>
        </label>

        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="blockPartial"
            className="mt-1 size-5"
            checked={blockPartial}
            onChange={(event) => setBlockPartial(event.target.checked)}
          />
          <span>
            <span className="font-medium">Block part payments</span>
            <span className="text-muted-foreground block text-xs">
              {/* The one the "voided notice" problem is actually about, said
                  plainly, because the person flipping it is deciding whether
                  an eviction survives. */}
              The full balance or nothing. In many states accepting a part
              payment after serving notice voids the notice.
            </span>
          </span>
        </label>

        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="certifiedFundsOnly"
            className="mt-1 size-5"
            checked={certifiedFundsOnly}
            onChange={(event) => setCertifiedFundsOnly(event.target.checked)}
          />
          <span>
            <span className="font-medium">Certified funds only</span>
            <span className="text-muted-foreground block text-xs">
              Closes every online rail, including bank transfer — an ACH debit
              can be returned days later. A cashier&rsquo;s cheque or money order
              is recorded by staff when it arrives.
            </span>
          </span>
        </label>
      </fieldset>

      <TextField
        label={held ? 'Why (required)' : 'Why this is changing (required)'}
        name="reason"
        required
        defaultValue={payer.reason ?? ''}
        hint="Recorded on the audit trail. This is what an eviction is argued from, and lifting a hold needs a reason as much as placing one does."
        idPrefix={`hold-${payer.id}`}
      />

      <FormAlerts state={state} />

      <SubmitButton label={held ? 'Apply these controls' : 'Lift all controls'} />
    </form>
  )
}

export function PaymentHoldPanel({
  payers,
  canSet,
  setHold,
}: {
  payers: readonly PayerHoldView[]
  /// False for somebody who can see the lease but may not stop its
  /// collection. The panel still SHOWS an active hold to them — that a
  /// tenancy is held is operationally important to anyone reading the lease
  /// — but offers no controls.
  canSet: boolean
  setHold: (state: BillingFormState, formData: FormData) => Promise<BillingFormState>
}) {
  const anyHeld = payers.some(
    (payer) => payer.blockOnline || payer.blockPartial || payer.certifiedFundsOnly,
  )

  if (payers.length === 0) return null

  return (
    <section aria-labelledby="payment-hold" className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="payment-hold" className="text-lg font-semibold">
          Legal-action payment controls
        </h2>
        {anyHeld && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            This tenancy is held
          </span>
        )}
      </div>

      <p className="text-muted-foreground text-sm">
        For a tenancy in legal action. The tenant is told only that the office
        needs to be contacted — never why — and every refused attempt is
        recorded.
      </p>

      {canSet ? (
        <div className="flex flex-col divide-y">
          {payers.map((payer) => (
            <HoldForm key={payer.id} payer={payer} action={setHold} />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {payers.map((payer) => (
            <li key={payer.id}>
              {payer.name}
              <span className="text-muted-foreground">
                {' · '}
                {payer.blockOnline || payer.blockPartial || payer.certifiedFundsOnly
                  ? [
                      payer.blockOnline ? 'online blocked' : null,
                      payer.blockPartial ? 'part payments blocked' : null,
                      payer.certifiedFundsOnly ? 'certified funds only' : null,
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : 'no controls'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
