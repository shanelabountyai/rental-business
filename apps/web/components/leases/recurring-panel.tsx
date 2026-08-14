'use client'

import { formatCents } from '@rental/core/money'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
import type { RecurringChargeFormState } from '@/lib/billing/recurring-actions.ts'

// Pet rent and flat utility fees (PAY-08, R-042).
//
// A SEPARATE SECTION FROM FEES, on the same reasoning that put waivers there
// rather than on the ledger. The Fees panel lists events that happened - a
// late fee assessed, a returned-payment fee - and offers to forgive one.
// These are terms of the tenancy that will keep happening, and the action
// they offer is to stop them.

export interface RecurringChargeView {
  id: string
  type: string
  amountCents: number
  description: string
  startsOn: string
  endsOn: string | null
  active: boolean
  /// True once Stripe is actually billing it. Shown, because "agreed" and
  /// "billing" are different states and the gap between them is a failed
  /// push the nightly sweep has not retried yet - which somebody looking at
  /// a tenant's invoice needs to be able to see.
  live: boolean
}

function EndForm({
  charge,
  action,
}: {
  charge: RecurringChargeView
  action: (
    state: RecurringChargeFormState,
    formData: FormData,
  ) => Promise<RecurringChargeFormState>
}) {
  const [state, formAction] = useActionState<RecurringChargeFormState, FormData>(action, {})

  return (
    // `<details>`, not a `useState` toggle - the toggle unmounts the button
    // holding focus, which is the R-099 defect the waiver form documents.
    <details open={Boolean(state.error)}>
      {/* Names the charge. Every row rendering "Stop this" identically is a
          screen reader listing N indistinguishable controls. */}
      <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-2">
        Stop {charge.description}
      </summary>
      <form action={formAction} className="flex flex-col gap-2 pt-2">
        <input type="hidden" name="recurringChargeId" value={charge.id} />
        <FormAlerts state={state} />
        <p className="text-muted-foreground text-sm">
          It stops appearing on the next invoice. The period already invoiced
          stands — a refund for part of a month is a waiver somebody decides
          on with a reason, not something this does quietly.
        </p>
        <SubmitButton label={`Stop ${formatCents(charge.amountCents)} a month`} />
      </form>
    </details>
  )
}

function AddForm({
  action,
  defaultStartsOn,
}: {
  action: (
    state: RecurringChargeFormState,
    formData: FormData,
  ) => Promise<RecurringChargeFormState>
  /// The lease's own start, which is what pet rent agreed at signing runs
  /// from.
  defaultStartsOn: string
}) {
  const [state, formAction] = useActionState<RecurringChargeFormState, FormData>(action, {})

  return (
    <details open={Boolean(state.error)}>
      <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-2">
        Add a monthly charge
      </summary>

      {/* A real `<form action>`, not an onClick handler - it works before
          hydration, which is the standard R-098 set for anything that has to
          work on first paint. */}
      <form action={formAction} className="flex flex-col gap-3 pt-3">
        <FormAlerts state={state} />

        <div className="flex flex-col gap-1">
          <label htmlFor="recurring-type" className="text-sm font-medium">
            What is it?
          </label>
          {/* Two options, because two is what core will accept. A free-text
              type would let somebody bill "late fee" every month with no
              statute ever consulted. */}
          <select
            id="recurring-type"
            name="type"
            defaultValue="PET_RENT"
            className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            aria-describedby={state.fieldErrors?.type ? 'recurring-type-error' : undefined}
          >
            <option value="PET_RENT">Pet rent</option>
            <option value="UTILITY">Flat utility fee</option>
          </select>
          <FieldError id="recurring-type-error" message={state.fieldErrors?.type} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="recurring-label" className="text-sm font-medium">
            What was agreed?
          </label>
          <input
            id="recurring-label"
            name="label"
            type="text"
            placeholder="Two cats"
            className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            aria-describedby={
              state.fieldErrors?.label ? 'recurring-label-error' : 'recurring-label-hint'
            }
          />
          <p id="recurring-label-hint" className="text-muted-foreground text-xs">
            The tenant reads this on every invoice, so name the thing — “Two
            cats”, “Trash, flat monthly”.
          </p>
          <FieldError id="recurring-label-error" message={state.fieldErrors?.label} />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="recurring-amount" className="text-sm font-medium">
            How much a month?
          </label>
          <input
            id="recurring-amount"
            name="amountDollars"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            placeholder="35.00"
            className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            aria-describedby={
              state.fieldErrors?.amountDollars ? 'recurring-amount-error' : undefined
            }
          />
          <FieldError
            id="recurring-amount-error"
            message={state.fieldErrors?.amountDollars}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="recurring-starts" className="text-sm font-medium">
              Billing from
            </label>
            {/* Native date input, per the platform-first rule: it is
                keyboard-accessible, localised and needs no JavaScript. */}
            <input
              id="recurring-starts"
              name="startsOn"
              type="date"
              defaultValue={defaultStartsOn}
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="recurring-ends" className="text-sm font-medium">
              Until <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="recurring-ends"
              name="endsOn"
              type="date"
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-describedby={
                state.fieldErrors?.endsOn ? 'recurring-ends-error' : 'recurring-ends-hint'
              }
            />
            <p id="recurring-ends-hint" className="text-muted-foreground text-xs">
              The first day it no longer bills. Leave it empty to run for the
              whole tenancy.
            </p>
            <FieldError id="recurring-ends-error" message={state.fieldErrors?.endsOn} />
          </div>
        </div>

        <SubmitButton label="Add this charge" />
      </form>
    </details>
  )
}

export function RecurringChargesPanel({
  charges,
  canWrite,
  defaultStartsOn,
  add,
  end,
}: {
  charges: readonly RecurringChargeView[]
  canWrite: boolean
  defaultStartsOn: string
  /// Bound to the lease on the server. A plain function cannot cross this
  /// boundary and `npm run build` does not catch the difference.
  add: (
    state: RecurringChargeFormState,
    formData: FormData,
  ) => Promise<RecurringChargeFormState>
  end: (
    state: RecurringChargeFormState,
    formData: FormData,
  ) => Promise<RecurringChargeFormState>
}) {
  if (charges.length === 0 && !canWrite) return null

  const monthlyCents = charges
    .filter((charge) => charge.active)
    .reduce((total, charge) => total + charge.amountCents, 0)

  return (
    <section aria-labelledby="recurring" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="recurring" className="text-lg font-semibold">
        Monthly charges beside the rent
      </h2>

      {charges.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          None. Pet rent and a flat utility fee bill with the rent on the same
          invoice.
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y">
            {charges.map((charge) => (
              <li key={charge.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={charge.active ? '' : 'text-muted-foreground'}>
                    <span className="font-medium">{charge.description}</span>
                  </span>
                  <span
                    className={
                      charge.active ? 'font-medium' : 'text-muted-foreground line-through'
                    }
                  >
                    {formatCents(charge.amountCents)}/month
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">
                  From {charge.startsOn}
                  {charge.endsOn ? ` until ${charge.endsOn}` : ''}
                  {charge.active
                    ? charge.live
                      ? ' · billing'
                      : ' · agreed, not yet on the invoice'
                    : ' · stopped'}
                </p>
                {charge.active && canWrite && <EndForm charge={charge} action={end} />}
              </li>
            ))}
          </ul>
          {monthlyCents > 0 && (
            <p className="text-sm">
              <span className="font-medium">{formatCents(monthlyCents)}</span> a month on
              top of the rent.
            </p>
          )}
        </>
      )}

      {canWrite && <AddForm action={add} defaultStartsOn={defaultStartsOn} />}

      <p className="text-muted-foreground text-xs">
        These bill on the same invoice as the rent. A charge whose amount
        changes every month — a utility bill split across units — is not one of
        these; record the bill and split it instead.
      </p>
    </section>
  )
}
