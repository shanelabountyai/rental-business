'use client'

import {
  ANIMAL_FORK_MESSAGES,
  LEGITIMIZATION_ROUTES,
  NOTICE_LANGUAGE_RULE,
  VIOLATION_GROUND_LABELS,
  VIOLATION_GROUNDS,
  VIOLATION_KIND_LABELS,
  VIOLATION_OUTCOME_LABELS,
  VIOLATION_OUTCOMES,
  animalCaseFork,
  type ViolationOutcome,
} from '@rental/core/violations'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { ViolationFormState } from '@/lib/violations/actions.ts'
import type { CaseView } from '@/lib/violations/queries.ts'

// The case file itself (RISK-02, RISK-03; R-088).

type Action = (state: ViolationFormState, formData: FormData) => Promise<ViolationFormState>

export interface ApplicantOption {
  id: string
  label: string
  screened: boolean
}

/** What the operator has to see before doing anything else on an animal case. */
export function AnimalForkNotice({
  hasApprovedAssistanceAnimal,
  hasUndecidedRequest,
}: {
  hasApprovedAssistanceAnimal: boolean
  hasUndecidedRequest: boolean
}) {
  const fork = animalCaseFork({ hasApprovedAssistanceAnimal, hasUndecidedRequest })
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      {ANIMAL_FORK_MESSAGES[fork]}
    </p>
  )
}

export function ObservationsPanel({
  caseFile,
  action,
}: {
  caseFile: CaseView
  action: Action
}) {
  const [state, formAction] = useActionState<ViolationFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const isCondition = caseFile.kind === 'PREMISES_CONDITION'

  return (
    <section aria-labelledby="observations" className="flex flex-col gap-4">
      <h2 id="observations" className="text-lg font-semibold">
        What was seen, and when
      </h2>

      {caseFile.observations.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {caseFile.observations.map((observation) => (
            <li key={observation.id} className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {observation.observedOn}
                {observation.ground ? ` · ${VIOLATION_GROUND_LABELS[observation.ground]}` : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{observation.note}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Recorded by {observation.recordedByName}
                {observation.photos.length > 0
                  ? ` · ${observation.photos.length} photo${observation.photos.length === 1 ? '' : 's'}`
                  : ''}
              </p>
              {observation.photos.length > 0 && (
                <ul className="text-muted-foreground mt-1 text-xs">
                  {observation.photos.map((photo) => (
                    <li key={photo.id}>
                      {photo.fileName}
                      {photo.capturedAt
                        ? ` — taken ${photo.capturedAt.toISOString().slice(0, 10)}`
                        : ' — no timestamp in the file'}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      {caseFile.status === 'OPEN' && (
        <form action={formAction} className="flex flex-col gap-3 rounded-md border p-3">
          <input type="hidden" name="caseId" value={caseFile.id} />
          <FormAlerts state={state} />
          <p className="text-sm font-medium">Record another visit</p>

          {isCondition && (
            <>
              <SelectField
                label="Which lease or safety term"
                name="ground"
                required
                idPrefix="obs"
                error={errors.ground}
                options={VIOLATION_GROUNDS.map((value) => ({
                  value,
                  label: VIOLATION_GROUND_LABELS[value],
                }))}
              />
              <p className="text-muted-foreground text-sm">{NOTICE_LANGUAGE_RULE}</p>
            </>
          )}

          <TextField
            label="Date it was seen"
            name="observedOn"
            type="date"
            required
            idPrefix="obs"
            error={errors.observedOn}
          />
          <TextareaField
            label="What was seen, and where"
            name="note"
            required
            idPrefix="obs"
            error={errors.note}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="obs-photo" className="text-sm font-medium">
              A photo from this visit
            </label>
            <input
              id="obs-photo"
              name="photo"
              type="file"
              accept="image/*"
              className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
            <p className="text-muted-foreground text-xs">
              The photo’s own timestamp is read from it and kept. A picture that
              cannot say which visit it came from shows the condition existed at
              some point, which is not what anybody is arguing about.
            </p>
            <FieldError id="obs-photo-error" message={errors.photo} />
          </div>
          <SubmitButton label="Record this visit" />
        </form>
      )}
    </section>
  )
}

export function AccommodationLinkPanel({
  caseFile,
  linkable,
  action,
}: {
  caseFile: CaseView
  /// Requests on the tenancy not yet attached to any case.
  linkable: { id: string; label: string }[]
  action: Action
}) {
  const [state, formAction] = useActionState<ViolationFormState, FormData>(action, {})

  return (
    <section aria-labelledby="case-accommodations" className="flex flex-col gap-3">
      <h2 id="case-accommodations" className="text-lg font-semibold">
        Accommodations asked for in response
      </h2>
      <p className="text-muted-foreground text-sm">
        A request attached here is the accommodation this case can be closed
        against. Hoarding disorder is a recognised disability, so a request
        arriving in the middle of a condition case is the ordinary course, not a
        tactic.
      </p>

      {caseFile.accommodationRequests.length === 0 ? (
        <p className="text-sm">None attached.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {caseFile.accommodationRequests.map((request) => (
            <li key={request.id}>
              {request.kind} · {request.status} · received {request.receivedOn}
            </li>
          ))}
        </ul>
      )}

      {caseFile.status === 'OPEN' && linkable.length > 0 && (
        <form action={formAction} className="flex flex-col gap-3 rounded-md border p-3">
          <input type="hidden" name="caseId" value={caseFile.id} />
          <FormAlerts state={state} />
          <SelectField
            label="Attach a request from this tenancy"
            name="requestId"
            required
            idPrefix="link"
            options={linkable.map((r) => ({ value: r.id, label: r.label }))}
          />
          <SubmitButton label="Attach it" />
        </form>
      )}
    </section>
  )
}

export function CloseCasePanel({
  caseFile,
  applicants,
  hasUndecidedRequest,
  action,
}: {
  caseFile: CaseView
  applicants: ApplicantOption[]
  hasUndecidedRequest: boolean
  action: Action
}) {
  const [state, formAction] = useActionState<ViolationFormState, FormData>(action, {})
  const [outcome, setOutcome] = useState<string>('')
  const errors = state.fieldErrors ?? {}
  const route = LEGITIMIZATION_ROUTES[caseFile.kind]

  const offered: ViolationOutcome[] = VIOLATION_OUTCOMES.filter(
    (value) => value !== 'LEGITIMIZED' || route.available,
  )

  return (
    <section aria-labelledby="close-case" className="flex flex-col gap-3">
      <h2 id="close-case" className="text-lg font-semibold">
        How this ended
      </h2>

      {route.available && (
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">Bringing it within the lease</p>
          <ol className="mt-1 list-decimal pl-5">
            {route.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="caseId" value={caseFile.id} />
        <FormAlerts state={state} />

        <SelectField
          label="How did this end?"
          name="outcome"
          required
          idPrefix="close"
          error={errors.outcome}
          options={offered.map((value) => ({ value, label: VIOLATION_OUTCOME_LABELS[value] }))}
          onChange={(event) => setOutcome(event.target.value)}
        />

        {outcome === 'LEGITIMIZED' && caseFile.kind === 'UNAUTHORIZED_OCCUPANT' && (
          <>
            <SelectField
              label="The application they went through"
              name="legitimizedApplicantId"
              required
              idPrefix="close"
              error={errors.legitimizedApplicantId}
              options={applicants.map((a) => ({
                value: a.id,
                label: a.screened ? a.label : `${a.label} — not screened yet`,
              }))}
            />
            <p className="text-muted-foreground text-sm">
              Screened against the current written criteria, unchanged. An
              occupant held to a laxer standard than the last person who applied
              for a unit here is disparate treatment, recorded in this system
              with a name and a date on it.
            </p>
          </>
        )}

        {outcome === 'LEGITIMIZED' && caseFile.kind === 'UNAUTHORIZED_ANIMAL' && (
          <>
            <TextField
              label="The animal being authorized"
              name="authorizedAnimal"
              required
              idPrefix="close"
              error={errors.authorizedAnimal}
              hint="Species, and a name if there is one."
            />
            {hasUndecidedRequest && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                There is an undecided accommodation request on this tenancy.
                Authorizing this animal as a pet answers it in the direction that
                costs the tenant money, before anybody has decided it. Decide the
                request first.
              </p>
            )}
          </>
        )}

        <TextareaField
          label="The account of how it ended"
          name="outcomeNote"
          required
          idPrefix="close"
          error={errors.outcomeNote}
          hint="Read eighteen months from now by somebody who was not there."
        />

        {outcome === 'ESCALATED' && hasUndecidedRequest && (
          <TextareaField
            label="Why escalate with a request still open"
            name="overrideReason"
            required
            idPrefix="close"
            error={errors.overrideReason}
            hint="This sequence is what a failure-to-accommodate claim is built from. It may still be the right call — and the request is owed a written determination either way."
          />
        )}

        <SubmitButton label="Close this case" />
      </form>
    </section>
  )
}

export function CaseHeader({ caseFile }: { caseFile: CaseView }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold">{VIOLATION_KIND_LABELS[caseFile.kind]}</h1>
      <p className="text-muted-foreground text-sm">
        {caseFile.propertyName} · {caseFile.unitLabel} ·{' '}
        <a href={`/leases/${caseFile.leaseId}`} className="underline underline-offset-2">
          {caseFile.tenantNames.join(', ') || 'the tenancy'}
        </a>
      </p>
      <p className="text-sm">
        {caseFile.status === 'OPEN'
          ? `Open since ${caseFile.openedAt.toISOString().slice(0, 10)}, opened by ${caseFile.openedByName}.`
          : `Closed — ${VIOLATION_OUTCOME_LABELS[caseFile.outcome!]}.`}
      </p>
      {caseFile.status === 'CLOSED' && caseFile.outcomeNote && (
        <p className="text-sm whitespace-pre-wrap">{caseFile.outcomeNote}</p>
      )}
    </div>
  )
}

/**
 * The notice series and where the cure period stands.
 *
 * Read-only. Notices are generated and served from the notices surface
 * (R-051), and putting a second serve form here would be a second copy of the
 * one place that records `permittedByJurisdiction` — the verdict the whole
 * cure clock turns on.
 */
export function NoticeSeriesPanel({ caseFile }: { caseFile: CaseView }) {
  const { cure } = caseFile
  return (
    <section aria-labelledby="notice-series" className="flex flex-col gap-3">
      <h2 id="notice-series" className="text-lg font-semibold">
        Notices served on this case
      </h2>

      {caseFile.notices.length === 0 ? (
        <p className="text-muted-foreground text-sm">None yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {caseFile.notices.map((notice) => (
            <li key={notice.id}>
              <a href={`/notices/${notice.id}`} className="underline underline-offset-2">
                {notice.type}
              </a>{' '}
              <span className="text-muted-foreground">
                · generated {notice.generatedAt.toISOString().slice(0, 10)}
                {notice.servedAt ? ` · served ${notice.servedAt.toISOString().slice(0, 10)}` : ' · not served'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm">
        {cure.state === 'not_served' && 'No notice has been served, so no cure period is running.'}
        {cure.state === 'defective_service' &&
          'Every service recorded so far was marked impermissible for this jurisdiction, so no cure period is running.'}
        {cure.state === 'running' &&
          (cure.periodUnknown
            ? `Running from ${cure.runsFrom}. This product has not been taught this state's cure period for a non-monetary breach, so it will not name a deadline — that number is in JurisdictionRule and is deliberately not guessed.`
            : `Running from ${cure.runsFrom}. Last day to cure is ${cure.cureBy}.`)}
        {cure.state === 'expired' &&
          `The cure period ran from ${cure.runsFrom} and expired on ${cure.cureBy}.`}
      </p>
    </section>
  )
}
