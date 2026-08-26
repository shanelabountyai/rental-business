'use client'

import {
  ACCOMMODATION_KIND_LABELS,
  ACCOMMODATION_KINDS,
  type AccommodationKind,
  clockSummary,
  documentationRequestable,
  DOCUMENTATION_REFUSAL_MESSAGES,
  LAWFUL_DENIAL_GROUNDS,
  isAnimalKind,
  REQUEST_STATUS_LABELS,
  type RequestStatus,
  responseClock,
} from '@rental/core/accommodations'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { AccommodationFormState } from '@/lib/accommodations/actions.ts'

// Reasonable-accommodation requests on one tenancy (RISK-13, R-086; widened
// to non-animal accommodations by R-088 for RISK-03's hoarding cases).

type Action = (state: AccommodationFormState, formData: FormData) => Promise<AccommodationFormState>

export interface RequestRow {
  id: string
  kind: AccommodationKind
  status: RequestStatus
  requesterName: string
  requestText: string
  subjectDescription: string | null
  disabilityObservable: boolean
  needObservable: boolean
  receivedOn: string
  infoRequestedOn: string | null
  decidedOn: string | null
  determinationText: string | null
  decidedByName: string | null
  documents: { id: string; fileName: string }[]
}

const STATUS_TONE: Record<RequestStatus, string> = {
  RECEIVED: 'bg-amber-100 text-amber-900',
  INFO_REQUESTED: 'bg-amber-100 text-amber-900',
  APPROVED: 'bg-green-100 text-green-900',
  DENIED: 'bg-neutral-200 text-neutral-900',
  WITHDRAWN: 'bg-neutral-200 text-neutral-900',
}

function IntakeForm({
  leaseId,
  action,
  tenants,
}: {
  leaseId: string
  action: Action
  tenants: readonly { id: string; name: string }[]
}) {
  const [state, formAction] = useActionState<AccommodationFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="leaseId" value={leaseId} />

      <SelectField
        label="Who asked"
        name="tenantId"
        idPrefix="accom"
        options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
        placeholder="A tenant on the lease…"
      />
      <TextField
        label="…or a name, if they are not on the lease"
        name="requestedByName"
        idPrefix="accom"
        error={errors.requestedByName}
        hint="The person with the disability is not always the leaseholder, and a request from them still counts."
      />

      <SelectField
        label="What is being asked for"
        name="kind"
        required
        idPrefix="accom"
        error={errors.kind}
        options={ACCOMMODATION_KINDS.map((value) => ({ value, label: ACCOMMODATION_KIND_LABELS[value] }))}
      />

      <TextField
        label="Date it arrived"
        name="receivedOn"
        type="date"
        required
        idPrefix="accom"
        error={errors.receivedOn}
        hint="The date THEY asked, not the date you are typing this. The clock runs from it."
      />

      <TextareaField
        label="What was asked for"
        name="requestText"
        required
        rows={3}
        idPrefix="accom"
        error={errors.requestText}
        hint="In their words where you have them — a text message, a note, what they said at the door."
      />

      {/* The two observations that decide whether documentation may lawfully
          be requested. Asked here, at intake, because they are assessments
          of a moment and a complaint asks what was known then. */}
      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">What was already apparent</legend>
        <p className="text-muted-foreground text-xs">
          Either one of these being obvious removes any basis for asking for
          documentation. Answer them honestly — they are what a complaint
          turns on.
        </p>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" name="disabilityObservable" className="mt-1 size-5" />
          <span>The disability itself is readily observable</span>
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" name="needObservable" className="mt-1 size-5" />
          <span>The animal&rsquo;s disability-related work or task is readily observable</span>
        </label>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="accom-support" className="text-sm font-medium">
          Anything they sent with it
        </label>
        <input
          id="accom-support"
          name="support"
          type="file"
          accept="application/pdf,image/*"
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <FieldError id="accom-support-error" message={errors.support} />
      </div>

      <FormAlerts state={state} />
      <SubmitButton label="Log this request" />
    </form>
  )
}

function DocumentationForm({
  request,
  action,
}: {
  request: RequestRow
  action: Action
}) {
  const [state, formAction] = useActionState<AccommodationFormState, FormData>(action, {})

  const decision = documentationRequestable({
    kind: request.kind,
    disabilityObservable: request.disabilityObservable,
    needObservable: request.needObservable,
  })

  // SAID BEFORE THE BUTTON EXISTS, not after it is pressed. The server
  // refuses either way; showing the reason here is what stops somebody
  // reaching for a workaround.
  if (!decision.requestable) {
    return (
      <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">
        {DOCUMENTATION_REFUSAL_MESSAGES[decision.refusal!]}
      </p>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="requestId" value={request.id} />
      <TextField
        label="What you asked for"
        name="note"
        idPrefix={`doc-${request.id}`}
        hint="Reliable documentation of the disability-related need — never the diagnosis, never records."
      />
      <FormAlerts state={state} />
      <SubmitButton label="Record that documentation was requested" />
    </form>
  )
}

function DecisionForm({ request, action }: { request: RequestRow; action: Action }) {
  const [state, formAction] = useActionState<AccommodationFormState, FormData>(action, {})
  const [outcome, setOutcome] = useState('')
  const errors = state.fieldErrors ?? {}
  // What the server handed back after a refusal wins over local state, so a
  // second attempt starts from what was actually submitted rather than from
  // an emptied form - see `AccommodationFormState.values`.
  const submitted = state.values
  const currentOutcome = submitted?.outcome ?? outcome

  return (
    <form action={formAction} className="flex flex-col gap-3 border-t pt-3">
      <input type="hidden" name="requestId" value={request.id} />
      {/* NOT "Determination", which is a substring of "The written
          determination" further down this same form — two controls whose
          accessible names contain one another are ambiguous to a locator and
          to anyone listening to them read out. */}
      <SelectField
        label="Approve or deny"
        name="outcome"
        required
        idPrefix={`dec-${request.id}`}
        error={errors.outcome}
        defaultValue={currentOutcome}
        options={[
          { value: 'APPROVED', label: 'Approve' },
          { value: 'DENIED', label: 'Deny' },
        ]}
        onChange={(event) => setOutcome(event.target.value)}
      />

      {currentOutcome === 'APPROVED' && (
        <>
          {isAnimalKind(request.kind) ? (
            <TextField
              label="Which animal"
              name="subjectDescription"
              required
              idPrefix={`dec-${request.id}`}
              error={errors.subjectDescription}
              defaultValue={submitted?.subjectDescription ?? request.subjectDescription ?? ''}
              hint="Species, and a name if there is one. A dispute two years later is about which animal."
            />
          ) : (
            <TextField
              label="The exception being granted"
              name="subjectDescription"
              required
              idPrefix={`dec-${request.id}`}
              error={errors.subjectDescription}
              defaultValue={submitted?.subjectDescription ?? request.subjectDescription ?? ''}
              hint="Exactly what is being changed, and for how long. An approval against an unrecorded scope is what the disagreement two years from now is about."
            />
          )}
          {isAnimalKind(request.kind) && (
            <p className="text-muted-foreground text-sm">
              Approving stops pet rent, pet fees and pet deposits on this
              tenancy — the product will refuse them.
            </p>
          )}
        </>
      )}

      {currentOutcome === 'DENIED' && (
        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">The grounds the FHA actually permits</p>
          <ul className="text-muted-foreground mt-1 list-disc pl-5 text-sm">
            {LAWFUL_DENIAL_GROUNDS.map((ground) => (
              <li key={ground}>{ground}</li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-xs">
            Write what actually happened rather than picking the nearest of
            these. They are a reminder, not a menu.
          </p>
        </div>
      )}

      <TextareaField
        label="The written determination"
        name="determinationText"
        required
        rows={4}
        idPrefix={`dec-${request.id}`}
        error={errors.determinationText}
        defaultValue={submitted?.determinationText ?? ''}
        hint="Sent to the requester as written. This is the record."
      />

      <FormAlerts state={state} />
      <SubmitButton label="Record the determination" />
    </form>
  )
}

export function AccommodationsPanel({
  leaseId,
  requests,
  tenants,
  canManage,
  today,
  receiveAction,
  documentationAction,
  decideAction,
}: {
  leaseId: string
  requests: readonly RequestRow[]
  tenants: readonly { id: string; name: string }[]
  canManage: boolean
  /// The property's own business date, computed server-side — the clock is
  /// measured in the property's calendar days, not the browser's.
  today: string
  receiveAction: Action
  /// Plain bound actions, one each — NOT `(id) => Action` factories. See
  /// `requestDocumentation`'s own comment: a function created on the server
  /// and handed to a client component has no identity the client can call.
  /// Each form carries its own `requestId` in a hidden field instead.
  documentationAction: Action
  decideAction: Action
}) {
  const open = requests.filter((r) => r.status === 'RECEIVED' || r.status === 'INFO_REQUESTED')

  return (
    <section aria-labelledby="accommodations" className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="accommodations" className="text-lg font-semibold">
          Accommodation requests
        </h2>
        {open.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {open.length} awaiting a determination
          </span>
        )}
      </div>

      <p className="text-muted-foreground text-sm">
        An assistance animal is not a pet: no pet rent, pet fee, pet deposit,
        or breed or size restriction may be applied to one. Respond as soon as
        you can — more than ten days is treated as unreasonable, and an
        unanswered request is treated as a refusal.
      </p>

      {requests.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing has been requested here.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((request) => {
            const clock = responseClock(request.receivedOn, request.decidedOn, today)
            return (
              <li key={request.id} className="flex flex-col gap-2 rounded-md border p-4">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{request.requesterName}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[request.status]}`}
                  >
                    {REQUEST_STATUS_LABELS[request.status]}
                  </span>
                </span>

                <span className="text-muted-foreground text-sm">
                  {ACCOMMODATION_KIND_LABELS[request.kind]} · received {request.receivedOn}
                  {request.infoRequestedOn && ` · documentation requested ${request.infoRequestedOn}`}
                </span>

                <span
                  className={
                    clock.overdue
                      ? 'text-sm font-medium text-red-800'
                      : 'text-muted-foreground text-sm'
                  }
                >
                  {clockSummary(clock)}
                </span>

                <p className="text-sm">{request.requestText}</p>

                {request.documents.length > 0 && (
                  <ul className="text-sm">
                    {request.documents.map((document) => (
                      <li key={document.id}>
                        <a
                          href={`/api/documents/${document.id}/file`}
                          className="underline underline-offset-2"
                        >
                          {document.fileName}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}

                {request.determinationText && (
                  <div className="rounded-md border p-3 text-sm">
                    <p className="font-medium">
                      {REQUEST_STATUS_LABELS[request.status]} on {request.decidedOn}
                      {request.decidedByName ? ` by ${request.decidedByName}` : ''}
                      {request.subjectDescription ? ` — ${request.subjectDescription}` : ''}
                    </p>
                    <p className="text-muted-foreground mt-1 whitespace-pre-wrap">
                      {request.determinationText}
                    </p>
                  </div>
                )}

                {canManage && request.status === 'RECEIVED' && (
                  <DocumentationForm
                    request={request}
                    action={documentationAction}
                  />
                )}

                {canManage &&
                  (request.status === 'RECEIVED' || request.status === 'INFO_REQUESTED') && (
                    <DecisionForm request={request} action={decideAction} />
                  )}
              </li>
            )
          })}
        </ul>
      )}

      {canManage && (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            Log a new request
          </summary>
          <div className="pt-3">
            <IntakeForm leaseId={leaseId} action={receiveAction} tenants={tenants} />
          </div>
        </details>
      )}
    </section>
  )
}
