'use client'

import { friendlyBusinessDate } from '@rental/core/scheduling'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField, TextField } from '@/components/form/field.tsx'
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
  const retaliation = state.needsRetaliationAck
  const noticePeriod = state.needsNoticePeriodAck
  // Only populated on a warning early return - see LeaseFormState's own
  // comment on `values` and ScheduleForm's identical note on why an
  // uncontrolled field needs this at all under React 19.
  const echoed = state.values ?? {}

  // Which fields to show - forwarding address only makes sense for the
  // tenant's own notice, a just-cause statement only for ours (R-066).
  // Defaults from the echoed value so a warning round trip does not lose
  // the choice already made.
  const [by, setBy] = useState(echoed.noticeGivenBy ?? '')

  // Whether a manual click has opened it, tracked so `open` is never pinned
  // to `Boolean(retaliation)` alone - that would make React re-assert
  // CLOSED on every render where there is no warning, and a tenant-given
  // notice (never a warning) would have forced this panel shut the moment
  // the success state came back. Derived at render time, not an effect:
  // open whenever the person opened it OR a warning needs to be seen: this
  // can only ever OPEN itself, never close a panel someone is looking at.
  const [manuallyOpened, setManuallyOpened] = useState(false)
  const open = manuallyOpened || Boolean(retaliation) || Boolean(noticePeriod)

  return (
    <details
      className="rounded-md border p-3"
      open={open}
      onToggle={(event) => setManuallyOpened(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer text-sm font-medium">
        Record notice to end the tenancy
      </summary>
      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <FormAlerts state={state} />
        <p className="text-muted-foreground text-sm">
          The tenancy keeps running — rent is still due and repairs are still
          owed. This records the date the clock started and when it actually ends.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Who gave notice"
            name="noticeGivenBy"
            required
            idPrefix="notice"
            defaultValue={echoed.noticeGivenBy}
            key={`by-${echoed.noticeGivenBy ?? ''}`}
            error={errors.noticeGivenBy}
            options={[
              { value: 'TENANT', label: 'The tenant' },
              { value: 'LANDLORD', label: 'We did' },
            ]}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setBy(event.target.value)}
          />
          <TextField
            label="Date notice was given"
            name="givenOn"
            type="date"
            idPrefix="notice"
            defaultValue={echoed.givenOn}
            key={`given-on-${echoed.givenOn ?? ''}`}
            error={errors.givenOn}
            hint="Leave blank for today."
          />
        </div>
        <TextField
          label="Date the tenancy actually ends"
          name="effectiveOn"
          type="date"
          required
          idPrefix="notice"
          defaultValue={echoed.effectiveOn}
          key={`effective-on-${echoed.effectiveOn ?? ''}`}
          error={errors.effectiveOn}
        />

        {by === 'TENANT' && (
          <TextField
            label="Forwarding address"
            name="forwardingAddress"
            idPrefix="notice"
            defaultValue={echoed.forwardingAddress}
            key={`forwarding-${echoed.forwardingAddress ?? ''}`}
            error={errors.forwardingAddress}
            hint="Where the deposit disposition goes once they are gone. Optional now, but chase it before they leave."
          />
        )}
        {by === 'LANDLORD' && (
          <TextareaField
            label="Reason for non-renewal"
            name="justCauseStatement"
            idPrefix="notice"
            defaultValue={echoed.justCauseStatement}
            key={`just-cause-${echoed.justCauseStatement ?? ''}`}
            error={errors.justCauseStatement}
            hint="Some jurisdictions require a stated cause for non-renewal. Filled in even where it is not required - it costs nothing and helps later."
            rows={2}
          />
        )}

        {noticePeriod && (
          <div className="flex flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
            <p className="text-sm font-medium">
              {noticePeriod.shortfallDays} day{noticePeriod.shortfallDays === 1 ? '' : 's'} short
              of the {noticePeriod.requiredDays}-day notice period this jurisdiction requires
            </p>
            <TextField
              label="Why is this notice this short?"
              name="noticePeriodReason"
              idPrefix="notice"
              required
              error={errors.noticePeriodReason}
            />
          </div>
        )}

        {retaliation && (
          <div className="flex flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
            <p className="text-sm font-medium">
              {retaliation.daysAgo} day{retaliation.daysAgo === 1 ? '' : 's'} after this
              tenant&rsquo;s {retaliation.category} complaint ({friendlyBusinessDate(retaliation.occurredOn)}) —
              inside the {retaliation.windowDays}-day retaliation-presumption window
            </p>
            <p className="text-muted-foreground text-sm">
              You can go ahead, but the business reason is recorded permanently and is
              what this notice would be defended with.
            </p>
            <TextField
              label="Why is this notice going out now?"
              name="retaliationReason"
              idPrefix="notice"
              required
              error={errors.retaliationReason}
            />
          </div>
        )}

        <SubmitButton
          label={
            retaliation || noticePeriod ? 'Record notice anyway, with this reason' : 'Record notice'
          }
        />
      </form>
    </details>
  )
}
