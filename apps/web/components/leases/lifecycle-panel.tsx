'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { LeaseFormState } from '@/lib/leases/actions.ts'

// Moving a lease through its lifecycle (LEASE-06, R-033).
//
// Only the transitions that are legal FROM HERE are rendered - the machine
// in packages/core/leases decides, and this asks it rather than
// re-implementing the rules in JSX. A button that appears and then refuses
// is a worse experience than one that was never there, and a second copy of
// the transition table would be the thing that drifts.

type Action = (state: LeaseFormState, formData: FormData) => Promise<LeaseFormState>

export function LifecyclePanel({
  offers,
  underNotice,
  noticeSummary,
  recordNotice,
}: {
  /// Pre-computed server-side from `leaseTransition`, each carrying its own
  /// ALREADY-BOUND server action - see the page.
  ///
  /// The action cannot be built here from a `(to) => bind(...)` factory
  /// passed down as a prop: a plain function crossing the server/client
  /// boundary is refused at runtime ("Functions cannot be passed directly to
  /// Client Components"), and it is refused for a good reason - only a
  /// `'use server'` export has an identity the client can call back to.
  offers: readonly {
    to: string
    label: string
    needsReason: boolean
    action: Action
  }[]
  underNotice: boolean
  noticeSummary: string | null
  recordNotice: Action
}) {
  return (
    <section aria-labelledby="lifecycle" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="lifecycle" className="text-lg font-semibold">
        Lifecycle
      </h2>

      {underNotice ? (
        <p className="text-sm">{noticeSummary}</p>
      ) : (
        <NoticeForm action={recordNotice} />
      )}

      {offers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing further happens to this lease. A tenancy that restarts is a new
          lease, not this one reopened.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {offers.map((offer) => (
            <TransitionForm
              key={offer.to}
              label={offer.label}
              needsReason={offer.needsReason}
              action={offer.action}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function TransitionForm({
  label,
  needsReason,
  action,
}: {
  label: string
  needsReason: boolean
  action: Action
}) {
  const [state, formAction] = useActionState<LeaseFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      {needsReason && (
        <TextField
          label="Why is this tenancy being cut short?"
          name="reason"
          required
          idPrefix={`terminate`}
          hint="“Ended” and “we had to end it” are different facts on the record."
        />
      )}
      <SubmitButton label={label} />
    </form>
  )
}

function NoticeForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState<LeaseFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <details className="rounded-md border p-3">
      <summary className="min-h-11 cursor-pointer text-sm font-medium">
        Record notice to end the tenancy
      </summary>
      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <FormAlerts state={state} />
        <p className="text-muted-foreground text-sm">
          The tenancy keeps running — rent is still due and repairs are still
          owed. This records the date the clock started.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Who gave notice"
            name="noticeGivenBy"
            required
            idPrefix="notice"
            error={errors.noticeGivenBy}
            options={[
              { value: 'TENANT', label: 'The tenant' },
              { value: 'LANDLORD', label: 'We did' },
            ]}
          />
          <TextField
            label="Date notice was given"
            name="givenOn"
            type="date"
            idPrefix="notice"
            error={errors.givenOn}
            hint="Leave blank for today."
          />
        </div>
        <SubmitButton label="Record notice" />
      </form>
    </details>
  )
}
