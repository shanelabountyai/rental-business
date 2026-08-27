'use client'

import {
  BELOW_DEDUCTIBLE_WARNING,
  CAUSE_OF_LOSS_LABELS,
  CLAIM_EVENT_KIND_LABELS,
  CLAIM_EVENT_KINDS,
  CLAIM_OUTCOME_LABELS,
  CLAIM_OUTCOMES,
  PAYMENT_CATEGORIES,
  PAYMENT_CATEGORY_LABELS,
  RENT_SOURCE_LABELS,
  mitigationSummary,
} from '@rental/core/insurance'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { ClaimFormState } from '@/lib/insurance/actions.ts'
import type { ClaimView } from '@/lib/insurance/queries.ts'

// The claim file (RISK-07, R-089).

type Action = (state: ClaimFormState, formData: FormData) => Promise<ClaimFormState>

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const day = (value: Date) => value.toISOString().slice(0, 10)

/**
 * The mitigation clock, and it is the first thing on the page.
 *
 * RISK-07's parenthesis — "mitigation speed decides water-claim disputes" —
 * is the whole reason this panel is at the top rather than in a details
 * block. An owner opening a fresh water claim has one useful next action, and
 * it is not filling in the adjuster's phone number.
 */
export function MitigationPanel({ claim }: { claim: ClaimView }) {
  const urgent = claim.mitigation.urgent
  return (
    <section
      aria-labelledby="mitigation"
      className={`flex flex-col gap-2 rounded-md border p-4 ${
        urgent ? 'border-amber-500/60 bg-amber-500/10' : ''
      }`}
    >
      <h2 id="mitigation" className="text-lg font-semibold">
        Mitigation
      </h2>
      <p className="text-sm">{mitigationSummary(claim.mitigation, claim.cause)}</p>
    </section>
  )
}

/**
 * Photographs, uploaded with nothing else in the form.
 *
 * Anything that made a photo wait for a category, a date and a note is a
 * photo that does not get taken — this gets used one-handed, standing in the
 * property, on the day.
 */
export function LossPhotosPanel({ claim, action }: { claim: ClaimView; action: Action }) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})

  return (
    <section aria-labelledby="loss-photos" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="loss-photos" className="text-lg font-semibold">
        Photographs of the loss
      </h2>

      {claim.documents.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing attached. Photograph everything before anything is moved or dried — this is the
          evidence a disputed claim is argued from, and it cannot be taken again later.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {claim.documents.map((document) => (
            <li key={document.id}>
              <a
                href={`/api/documents/${document.id}/file`}
                className="underline underline-offset-2"
              >
                {document.fileName}
              </a>{' '}
              <span className="text-muted-foreground">
                {document.capturedAt
                  ? `— taken ${day(document.capturedAt)}`
                  : '— no capture timestamp in the file'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {claim.status === 'OPEN' && (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="claimId" value={claim.id} />
          <FormAlerts state={state} />
          <label htmlFor="loss-files" className="text-sm font-medium">
            Add photographs or a short video
          </label>
          <input
            id="loss-files"
            name="photos"
            type="file"
            multiple
            accept="image/*,video/*"
            className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          <p className="text-muted-foreground text-xs">
            Each file keeps its own capture timestamp where it has one, which is what makes it
            evidence of <em>when</em>. Video is capped at about 25&nbsp;MB — a long walkthrough will
            be rejected.
          </p>
          <FieldError id="loss-files-error" message={state.fieldErrors?.photos} />
          <SubmitButton label="Attach these" />
        </form>
      )}
    </section>
  )
}

/**
 * Payout against cost.
 *
 * THE REPAIR COST IS NOT AN INPUT ANYWHERE ON THIS PAGE. It is summed from
 * the linked jobs, which is why the panel lists them with their individual
 * costs beside the total — a reader who thinks the number is wrong needs to
 * see which job is wrong, not a box to correct it in.
 */
export function PositionPanel({
  claim,
  linkAction,
  unlinkAction,
  linkableJobs,
}: {
  claim: ClaimView
  linkAction: Action
  unlinkAction: Action
  linkableJobs: { id: string; label: string }[]
}) {
  const [linkState, linkFormAction] = useActionState<ClaimFormState, FormData>(linkAction, {})
  const [, unlinkFormAction] = useActionState<ClaimFormState, FormData>(unlinkAction, {})
  const { position } = claim

  return (
    <section aria-labelledby="position" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="position" className="text-lg font-semibold">
        Payout against cost
      </h2>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt>Repair cost, from the jobs</dt>
        <dd className="text-right font-medium">{money(position.repairCostCents)}</dd>
        <dt>Deductible</dt>
        <dd className="text-right font-medium">
          {position.deductibleCents == null ? 'Not recorded on the policy' : money(position.deductibleCents)}
        </dd>
        <dt>Expected recovery</dt>
        <dd className="text-right font-medium">
          {position.expectedRecoveryCents == null
            ? 'Cannot be computed without a deductible'
            : money(position.expectedRecoveryCents)}
        </dd>
        <dt>Paid for the building</dt>
        <dd className="text-right font-medium">{money(position.paidByCategory.REPAIR)}</dd>
        <dt>Still outstanding</dt>
        <dd className="text-right font-medium">
          {position.shortfallCents == null ? '—' : money(position.shortfallCents)}
        </dd>
      </dl>

      {position.belowDeductible && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {BELOW_DEDUCTIBLE_WARNING}
        </p>
      )}

      <h3 className="text-sm font-medium">Jobs being recovered</h3>
      {claim.jobs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          None attached, so the repair cost is zero. Attach the work orders this loss produced —
          their recorded costs are what the claim is measured against, and there is deliberately
          nowhere here to type a figure instead.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {claim.jobs.map((job) => (
            <li key={job.id} className="flex items-center justify-between gap-2">
              <span>
                <a href={`/workorders/${job.id}`} className="underline underline-offset-2">
                  {job.scope}
                </a>{' '}
                <span className="text-muted-foreground">
                  · {job.status.toLowerCase().replace(/_/g, ' ')}
                  {job.capitalised ? ' · capitalised' : ''}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-medium">{money(job.costCents)}</span>
                {claim.status === 'OPEN' && (
                  <form action={unlinkFormAction}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <input type="hidden" name="workOrderId" value={job.id} />
                    {/* Names the job (R-116): one per linked work order, and
                        the row prints the scope already. */}
                    <button
                      type="submit"
                      className="text-muted-foreground hover:text-foreground min-h-11 text-sm underline underline-offset-2"
                    >
                      Remove<span className="sr-only"> {job.scope} from this claim</span>
                    </button>
                  </form>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {claim.status === 'OPEN' && linkableJobs.length > 0 && (
        <form action={linkFormAction} className="flex flex-col gap-3 rounded-md border p-3">
          <input type="hidden" name="claimId" value={claim.id} />
          <FormAlerts state={linkState} />
          <SelectField
            label="Attach a job from this property"
            name="workOrderId"
            required
            idPrefix="link-job"
            options={linkableJobs.map((job) => ({ value: job.id, label: job.label }))}
          />
          <SubmitButton label="Attach this job" />
        </form>
      )}
    </section>
  )
}

export function PaymentsPanel({ claim, action }: { claim: ClaimView; action: Action }) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="claim-payments" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="claim-payments" className="text-lg font-semibold">
        Money received
      </h2>

      {claim.payments.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing received yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {claim.payments.map((payment) => (
            <li key={payment.id} className="flex justify-between gap-2">
              <span>
                {payment.receivedOn} · {PAYMENT_CATEGORY_LABELS[payment.category]}
                {payment.reference ? ` · ${payment.reference}` : ''}
              </span>
              <span className="font-medium">{money(payment.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}

      {claim.status === 'OPEN' && (
        <form action={formAction} className="flex flex-col gap-3 rounded-md border p-3">
          <input type="hidden" name="claimId" value={claim.id} />
          <FormAlerts state={state} />
          <SelectField
            label="What was this payment for?"
            name="category"
            required
            idPrefix="pay"
            error={errors.category}
            options={PAYMENT_CATEGORIES.map((value) => ({
              value,
              label: PAYMENT_CATEGORY_LABELS[value],
            }))}
          />
          <p className="text-muted-foreground text-sm">
            This is the one field here that cannot be recovered later. Loss-of-rents proceeds are
            rental income and damage proceeds are not, and next January the bank line says “CLAIM
            SETTLEMENT” and nothing else.
          </p>
          <TextField
            label="How much arrived?"
            name="amount"
            required
            idPrefix="pay"
            inputMode="decimal"
            error={errors.amount}
          />
          <TextField
            label="Date it arrived"
            name="receivedOn"
            type="date"
            required
            idPrefix="pay"
            error={errors.receivedOn}
          />
          <TextField
            label="Cheque or transfer reference"
            name="reference"
            idPrefix="pay"
            error={errors.reference}
          />
          <SubmitButton label="Record this payment" />
        </form>
      )}
    </section>
  )
}

export function LossOfRentsPanel({ claim, units, action }: {
  claim: ClaimView
  units: { id: string; name: string }[]
  action: Action
}) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="loss-of-rents" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="loss-of-rents" className="text-lg font-semibold">
        Rent lost while it was down
      </h2>

      {/* A "no" here is a real answer and it is said plainly rather than the
          section quietly disappearing — an owner who assumes they are covered
          and finds out at settlement is the person this sentence is for. */}
      {!claim.lossOfRentsCovered && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          The policy on file is not recorded as carrying loss-of-rents cover. You can still build
          the figure — the record may be out of date, and a carrier that pays has settled the
          question better than our copy of the policy has — but check before relying on it.
        </p>
      )}

      {claim.lossOfRents ? (
        <p className="text-sm">
          {claim.lossOfRents.unitName} was down from {claim.lossOfRents.fromOn} to{' '}
          {claim.lossOfRents.toOn} — {claim.lossOfRents.days} day
          {claim.lossOfRents.days === 1 ? '' : 's'} at {money(claim.lossOfRents.monthlyRentCents)} a
          month, so <strong>{money(claim.lossOfRents.amountCents)}</strong>. Built on{' '}
          {RENT_SOURCE_LABELS[claim.lossOfRents.source]}.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">No downtime recorded.</p>
      )}

      {claim.status === 'OPEN' && (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="claimId" value={claim.id} />
          <FormAlerts state={state} />
          <SelectField
            label="Which unit was out of service"
            name="unitId"
            required
            idPrefix="lor"
            error={errors.unitId}
            options={units.map((unit) => ({ value: unit.id, label: unit.name }))}
          />
          <TextField
            label="Out of service from"
            name="lossOfRentsFromOn"
            type="date"
            required
            idPrefix="lor"
            error={errors.lossOfRentsFromOn}
          />
          <TextField
            label="Back in service on"
            name="lossOfRentsToOn"
            type="date"
            required
            idPrefix="lor"
            error={errors.lossOfRentsToOn}
          />
          <p className="text-muted-foreground text-sm">
            The rent is not typed in. The tenancy in the unit on the start date is found, and its
            contract rent used; where none covers the period the unit’s asking rent is used instead
            and the claim file says so.
          </p>
          <SubmitButton label="Record the downtime" />
        </form>
      )}
    </section>
  )
}

export function TimelinePanel({ claim, action }: { claim: ClaimView; action: Action }) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="claim-timeline" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="claim-timeline" className="text-lg font-semibold">
        What the carrier said, and when
      </h2>

      {claim.events.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing logged yet.</p>
      ) : (
        <ol className="flex flex-col gap-2 text-sm">
          {claim.events.map((event) => (
            <li key={event.id}>
              <span className="font-medium">
                {day(event.occurredAt)} — {CLAIM_EVENT_KIND_LABELS[event.kind]}
              </span>
              <p className="whitespace-pre-wrap">{event.note}</p>
              {event.documentId && (
                <a
                  href={`/api/documents/${event.documentId}/file`}
                  className="text-muted-foreground underline underline-offset-2"
                >
                  {event.documentName}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}

      {claim.status === 'OPEN' && (
        <form action={formAction} className="flex flex-col gap-3 rounded-md border p-3">
          <input type="hidden" name="claimId" value={claim.id} />
          <FormAlerts state={state} />
          <SelectField
            label="What happened on the claim"
            name="kind"
            required
            idPrefix="evt"
            error={errors.kind}
            options={CLAIM_EVENT_KINDS.map((value) => ({
              value,
              label: CLAIM_EVENT_KIND_LABELS[value],
            }))}
          />
          <TextField
            label="When it happened"
            name="occurredAt"
            type="datetime-local"
            required
            idPrefix="evt"
            error={errors.occurredAt}
          />
          <TextareaField
            label="What was actually said"
            name="note"
            required
            idPrefix="evt"
            error={errors.note}
            hint="“Spoke to adjuster” is not a record of anything. What did they say they would do, and by when?"
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="evt-document" className="text-sm font-medium">
              The letter or estimate behind it
            </label>
            <input
              id="evt-document"
              name="document"
              type="file"
              accept="image/*,application/pdf"
              className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </div>
          <SubmitButton label="Log it" />
        </form>
      )}
    </section>
  )
}

export function ClaimDetailsPanel({ claim, action }: { claim: ClaimView; action: Action }) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const localValue = (value: Date | null) => (value ? value.toISOString().slice(0, 16) : '')

  return (
    <section aria-labelledby="claim-details" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="claim-details" className="text-lg font-semibold">
        The carrier and the adjuster
      </h2>

      {claim.status === 'CLOSED' ? (
        <p className="text-sm">
          {claim.carrier}
          {claim.claimNumber ? ` · claim ${claim.claimNumber}` : ''}
          {claim.adjusterName ? ` · ${claim.adjusterName}` : ''}
        </p>
      ) : (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="claimId" value={claim.id} />
          <FormAlerts state={state} />
          <p className="text-muted-foreground text-sm">
            {claim.carrier}
            {claim.policyNumber ? ` · policy ${claim.policyNumber}` : ''}
            {claim.deductibleCents != null
              ? ` · ${money(claim.deductibleCents)} deductible`
              : ' · no deductible recorded on the policy'}
          </p>
          <TextField
            label="Claim number from the carrier"
            name="claimNumber"
            idPrefix="details"
            defaultValue={claim.claimNumber ?? ''}
            error={errors.claimNumber}
          />
          <TextField
            label="Adjuster’s name"
            name="adjusterName"
            idPrefix="details"
            defaultValue={claim.adjusterName ?? ''}
          />
          <TextField
            label="Adjuster’s firm"
            name="adjusterCompany"
            idPrefix="details"
            defaultValue={claim.adjusterCompany ?? ''}
          />
          <TextField
            label="Adjuster’s phone"
            name="adjusterPhone"
            idPrefix="details"
            defaultValue={claim.adjusterPhone ?? ''}
          />
          <TextField
            label="Adjuster’s email"
            name="adjusterEmail"
            idPrefix="details"
            defaultValue={claim.adjusterEmail ?? ''}
          />
          <TextField
            label="When mitigation started"
            name="mitigationStartedAt"
            type="datetime-local"
            idPrefix="details"
            defaultValue={localValue(claim.mitigationStartedAt)}
            error={errors.mitigationStartedAt}
          />
          <TextField
            label="When the carrier was told"
            name="reportedAt"
            type="datetime-local"
            idPrefix="details"
            defaultValue={localValue(claim.reportedAt)}
          />
          <SubmitButton label="Save these details" />
        </form>
      )}
    </section>
  )
}

export function CloseClaimPanel({ claim, action }: { claim: ClaimView; action: Action }) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="close-claim" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="close-claim" className="text-lg font-semibold">
        How the claim ended
      </h2>
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="claimId" value={claim.id} />
        <FormAlerts state={state} />
        <SelectField
          label="The settlement outcome"
          name="outcome"
          required
          idPrefix="close-claim"
          error={errors.outcome}
          options={CLAIM_OUTCOMES.map((value) => ({ value, label: CLAIM_OUTCOME_LABELS[value] }))}
        />
        <TextareaField
          label="What was agreed, and on what basis"
          name="outcomeNote"
          required
          idPrefix="close-claim"
          error={errors.outcomeNote}
          hint="Read at the next renewal, by somebody deciding whether this carrier is worth keeping."
        />
        <SubmitButton label="Close this claim" />
      </form>
    </section>
  )
}

export function ClaimHeader({ claim }: { claim: ClaimView }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">
        {CAUSE_OF_LOSS_LABELS[claim.cause].split(' — ')[0]} at {claim.propertyName}
      </h1>
      <p className="text-muted-foreground text-sm">
        Loss on {day(claim.incidentAt)} ·{' '}
        {claim.claimNumber ? `claim ${claim.claimNumber}` : 'no claim number yet'} ·{' '}
        {claim.status === 'OPEN'
          ? `open since ${day(claim.openedAt)}`
          : CLAIM_OUTCOME_LABELS[claim.outcome!]}
      </p>
      <p className="text-sm whitespace-pre-wrap">{claim.description}</p>
      {claim.status === 'CLOSED' && claim.outcomeNote && (
        <p className="text-sm whitespace-pre-wrap">{claim.outcomeNote}</p>
      )}
    </div>
  )
}
