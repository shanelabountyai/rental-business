'use client'

import { CAUSE_OF_LOSS_LABELS, CAUSES_OF_LOSS, CLAIM_OUTCOME_LABELS } from '@rental/core/insurance'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { ClaimFormState } from '@/lib/insurance/actions.ts'
import type { ClaimSummary } from '@/lib/insurance/queries.ts'

// Opening a claim from the property it happened at (RISK-07, R-089).
//
// The heading is "Claims on this property", not "Insurance claims": the
// property page already carries an "Insurance" section for policies and
// coverage, and `getByText`/`getByLabel` are case-insensitive SUBSTRING
// matches — so "Insurance claims" would collide with it in every spec that
// asserts on the policy section. The trap is written up in CLAUDE.md; this
// is the first panel added since, and it obeys it.

export function OpenClaimPanel({
  action,
  claims,
  policies,
}: {
  action: (state: ClaimFormState, formData: FormData) => Promise<ClaimFormState>
  claims: ClaimSummary[]
  policies: { id: string; carrier: string; policyNumber: string | null }[]
}) {
  const [state, formAction] = useActionState<ClaimFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="property-claims" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="property-claims" className="text-lg font-semibold">
        Claims on this property
      </h2>

      {claims.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {claims.map((claim) => (
            <li key={claim.id}>
              <a href={`/claims/${claim.id}`} className="underline underline-offset-2">
                {CAUSE_OF_LOSS_LABELS[claim.cause].split(' — ')[0]} ·{' '}
                {claim.incidentAt.toISOString().slice(0, 10)}
              </a>{' '}
              <span className="text-muted-foreground">
                {claim.status === 'OPEN' ? 'open' : CLAIM_OUTCOME_LABELS[claim.outcome!]}
              </span>
              {claim.mitigationUrgent && (
                <span className="text-amber-800 dark:text-amber-300">
                  {' '}
                  · nothing recorded as mitigated
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {policies.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No policy is on file for this property, so a claim cannot be opened. The deductible and
          whether loss of rents is covered both come from the policy — add one above first.
        </p>
      ) : (
        <details className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
            Open a claim
          </summary>
          <div className="flex flex-col gap-3 pt-3">
            <form action={formAction} className="flex flex-col gap-3">
              <FormAlerts state={state} />
              <SelectField
                label="Which policy"
                name="policyId"
                required
                idPrefix="claim"
                error={errors.policyId}
                options={policies.map((policy) => ({
                  value: policy.id,
                  label: policy.policyNumber
                    ? `${policy.carrier} — ${policy.policyNumber}`
                    : policy.carrier,
                }))}
              />
              <SelectField
                label="What caused the loss"
                name="cause"
                required
                idPrefix="claim"
                error={errors.cause}
                options={CAUSES_OF_LOSS.map((value) => ({
                  value,
                  label: CAUSE_OF_LOSS_LABELS[value],
                }))}
              />
              <TextField
                label="When the loss happened"
                name="incidentAt"
                type="datetime-local"
                required
                idPrefix="claim"
                error={errors.incidentAt}
              />
              <TextField
                label="When mitigation started, if it has"
                name="mitigationStartedAt"
                type="datetime-local"
                idPrefix="claim"
                error={errors.mitigationStartedAt}
                hint="Drying, boarding, making safe. The gap between this and the loss is what a disputed water claim turns on — it can be filled in later, but not invented later."
              />
              <TextareaField
                label="What happened"
                name="description"
                required
                idPrefix="claim"
                error={errors.description}
                hint="Read back to you by an adjuster who was not there, months from now."
              />
              <TextField
                label="Carrier’s claim number, if you have one"
                name="claimNumber"
                idPrefix="claim"
                error={errors.claimNumber}
              />
              <SubmitButton label="Open the claim" />
            </form>
          </div>
        </details>
      )}
    </section>
  )
}
