'use client'

import {
  NOTICE_LANGUAGE_RULE,
  VIOLATION_GROUND_LABELS,
  VIOLATION_GROUNDS,
  VIOLATION_KIND_LABELS,
  VIOLATION_KINDS,
  VIOLATION_OUTCOME_LABELS,
  type ViolationKind,
  type ViolationOutcome,
  type ViolationStatus,
} from '@rental/core/violations'
import { useActionState, useState } from 'react'
import { FormAlerts, LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { ViolationFormState } from '@/lib/violations/actions.ts'

// Opening a lease-violation case from the tenancy it is about (RISK-02,
// RISK-03; R-088).
//
// Behind a `<details>`, like the gone-dark panel beside it. Unlike that one
// the reason is not that this is grave — recording what you saw is the safe
// direction and is deliberately cheap — it is that `/leases/[id]` now carries
// a dozen panels and an always-open form is another dozen labels competing
// for the same page.

export interface LeaseCaseRow {
  id: string
  kind: ViolationKind
  status: ViolationStatus
  outcome: ViolationOutcome | null
  /// Formatted by the caller, which is where the property timezone lives -
  /// same as every other lease-page panel that shows a date.
  openedOn: string
  observationCount: number
}

export function OpenViolationCasePanel({
  action,
  cases,
}: {
  action: (state: ViolationFormState, formData: FormData) => Promise<ViolationFormState>
  cases: LeaseCaseRow[]
}) {
  const [state, formAction] = useActionState<ViolationFormState, FormData>(action, {})
  const [kind, setKind] = useState<string>('')
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="violations" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="violations" className="text-lg font-semibold">
        Lease violations
      </h2>

      {cases.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {cases.map((row) => (
            <li key={row.id}>
              <a href={`/violations/${row.id}`} className="underline underline-offset-2">
                {VIOLATION_KIND_LABELS[row.kind]}
              </a>{' '}
              <span className="text-muted-foreground">
                · {row.status === 'OPEN' ? 'open' : VIOLATION_OUTCOME_LABELS[row.outcome!]} ·{' '}
                {row.observationCount} observation{row.observationCount === 1 ? '' : 's'} · opened{' '}
                {row.openedOn}
              </span>
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          Open a violation case
        </summary>
        <div className="flex flex-col gap-3 pt-3">
          <p className="text-muted-foreground text-sm">
            A case is a dated record of what was seen, the notices served on it,
            and how it ended. The commonest ending for an occupant or an animal
            is that it is brought within the lease, not that anybody leaves.
          </p>
          <form action={formAction} className="flex flex-col gap-3">
            <FormAlerts state={state} />

            <SelectField
              label="What is being alleged?"
              name="kind"
              required
              idPrefix="viol"
              error={errors.kind}
              options={VIOLATION_KINDS.map((value) => ({
                value,
                label: VIOLATION_KIND_LABELS[value],
              }))}
              onChange={(event) => setKind(event.target.value)}
            />

            {/* THE FAIR-HOUSING WARNING IS THE ONE SENTENCE ON THIS SCREEN
                NOBODY MAY MISS, and it was inserted into the DOM with no live
                region at all (R-116): choosing "Unauthorized animal" told a
                screen-reader user nothing. `assertive` for the reason
                `LiveRegion` reserves it - serving this notice on an assistance
                animal is a fair-housing complaint, so the choice should not be
                carried on past without reading it. Mounted from first paint
                whatever the chosen kind, because a region that ARRIVES holding
                its text is a new node rather than a change. */}
            <LiveRegion assertive>
              {kind === 'UNAUTHORIZED_ANIMAL' && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  Ask first whether it is a service or assistance animal. A tenant
                  is not required to volunteer that, and a notice served on an
                  assistance animal is a fair-housing complaint whether or not
                  anybody had been told. If the answer is yes, log an
                  accommodation request instead of opening this.
                </p>
              )}
            </LiveRegion>

            {/* Polite: a required field appearing is worth knowing about, but
                it is below the cursor and the submit refuses without it. */}
            <LiveRegion>
              {kind === 'PREMISES_CONDITION' && (
                <>
                  <SelectField
                    label="Which lease or safety term"
                    name="ground"
                    required
                    idPrefix="viol"
                    error={errors.ground}
                    options={VIOLATION_GROUNDS.map((value) => ({
                      value,
                      label: VIOLATION_GROUND_LABELS[value],
                    }))}
                  />
                  <p className="text-muted-foreground text-sm">{NOTICE_LANGUAGE_RULE}</p>
                </>
              )}
            </LiveRegion>

            <TextField
              label="Date it was seen"
              name="observedOn"
              type="date"
              required
              idPrefix="viol"
              error={errors.observedOn}
            />
            <TextareaField
              label="What was seen, and where"
              name="note"
              required
              idPrefix="viol"
              error={errors.note}
              hint="The room, and what about it breaches the term. Photographs show a state; only this says which room and why it matters."
            />
            <SubmitButton label="Open the violation case" />
          </form>
        </div>
      </details>
    </section>
  )
}
