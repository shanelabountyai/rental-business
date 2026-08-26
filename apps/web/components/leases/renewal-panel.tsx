'use client'

import { useActionState } from 'react'
import { FormAlerts, LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import { TextField, TextareaField } from '@/components/form/field.tsx'
import type { RenewalFormState } from '@/lib/leases/renewal-actions.ts'

// The renewal-offer section (LEASE-09, R-065): "the owner sees current vs.
// proposed rent" and, when a rent increase runs into a jurisdiction rule,
// "the system blocks/warns with the specific rule." A statutory CAP has no
// override field at all - see packages/core/leases/renewal.ts's own header
// for why a ceiling and a notice-period shortfall get different postures.

export interface RenewalLineageLease {
  id: string
  status: string
  startsOn?: string
  endsOn?: string | null
  rentCents: number
}

export function RenewalPanel({
  canOffer,
  currentRentCents,
  marketRentCents,
  defaultStartsOn,
  defaultEndsOn,
  predecessor,
  successors,
  action,
}: {
  canOffer: boolean
  currentRentCents: number
  marketRentCents: number | null
  defaultStartsOn: string
  defaultEndsOn: string
  predecessor: RenewalLineageLease | null
  successors: readonly RenewalLineageLease[]
  action: (state: RenewalFormState, formData: FormData) => Promise<RenewalFormState>
}) {
  const [state, formAction] = useActionState<RenewalFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const centsToDollars = (cents: number) => (cents / 100).toFixed(2)

  if (!canOffer && successors.length === 0 && !predecessor) return null

  return (
    <section aria-labelledby="renewal" className="flex flex-col gap-4 rounded-md border p-4">
      <h2 id="renewal" className="text-sm font-semibold">
        Renewal
      </h2>

      {predecessor && (
        <p className="text-muted-foreground text-sm">
          Renewed from{' '}
          <a href={`/leases/${predecessor.id}`} className="underline underline-offset-2">
            the previous lease
          </a>
          .
        </p>
      )}
      {successors.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {successors.map((s) => (
            <li key={s.id}>
              <a href={`/leases/${s.id}`} className="underline underline-offset-2">
                Renewal offer
              </a>{' '}
              — {s.status.toLowerCase().replaceAll('_', ' ')}, {centsToDollars(s.rentCents)}
              /mo starting {s.startsOn}
            </li>
          ))}
        </ul>
      )}

      {canOffer && (
        <form action={formAction} className="flex flex-col gap-4">
          <FormAlerts state={state} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Current rent</dt>
            <dd>{centsToDollars(currentRentCents)}/mo</dd>
            <dt className="text-muted-foreground">Market rent</dt>
            <dd>{marketRentCents != null ? `${centsToDollars(marketRentCents)}/mo` : 'Not set on the unit'}</dd>
          </dl>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TextField
              label="New start date"
              name="startsOn"
              type="date"
              required
              idPrefix="renewal"
              defaultValue={state.values?.startsOn || defaultStartsOn}
              error={errors.startsOn}
            />
            <TextField
              label="New end date"
              name="endsOn"
              type="date"
              required
              idPrefix="renewal"
              defaultValue={state.values?.endsOn || defaultEndsOn}
              error={errors.endsOn}
            />
            <TextField
              label="Proposed rent ($/mo)"
              name="rentDollars"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.01}
              required
              idPrefix="renewal"
              defaultValue={state.values?.rentDollars || centsToDollars(currentRentCents)}
              error={errors.rentDollars}
            />
          </div>
          <LiveRegion assertive>
            {state.capped && (
              <p className="text-sm text-red-700">
                The most this may legally increase to is{' '}
                {centsToDollars(state.capped.maxAllowedCents)}/mo.
              </p>
            )}
          </LiveRegion>
          {state.needsOverride && (
            <TextareaField
              label="Why proceed with less than the required notice?"
              name="overrideReason"
              required
              idPrefix="renewal"
              error={errors.overrideReason}
              rows={2}
            />
          )}
          <SubmitButton label="Create renewal offer" />
        </form>
      )}
    </section>
  )
}
