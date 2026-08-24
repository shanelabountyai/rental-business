'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { DOCUMENTATION_IS_NOT_STORED, DOCUMENTATION_LABELS } from '@rental/core/confidential'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { ConfidentialFormState } from '@/lib/confidential/actions.ts'

// Opening a confidential safety case from the tenancy it concerns (RISK-04,
// ROLE-05; R-091).
//
// RENDERED ONLY FOR SOMEBODY HOLDING `confidential.manage`, which is the
// Owner role by default. A manager looking at this lease sees no control, no
// heading and no count - not a disabled button and not an explanation, both
// of which would announce that the feature applies here.
//
// FOLDED INTO A `<details>` closed by default. The one on this page an owner
// opens deliberately: a lease page is shown to people, and a panel headed
// like this one sitting open is the disclosure.
//
// The heading is "Confidential case" and not what it is for. Every other
// panel on /leases/[id] says what it does; this one deliberately does not,
// and the labels inside are neutral for the same reason.

type Action = (state: ConfidentialFormState, formData: FormData) => Promise<ConfidentialFormState>

export function OpenConfidentialCasePanel({
  leaseId,
  openCount,
  totalCount,
  today,
  tenantOptions,
  action,
}: {
  leaseId: string
  openCount: number
  totalCount: number
  today: string
  tenantOptions: readonly { id: string; label: string }[]
  action: Action
}) {
  const [state, submit] = useActionState<ConfidentialFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="confidential" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="confidential" className="text-lg font-semibold">
        Confidential case
      </h2>
      <p className="text-muted-foreground text-sm">
        Restricted to staff holding the confidential permission. Nothing recorded here appears
        on this page, in any queue, or to anybody else.
      </p>

      {totalCount > 0 && (
        <p className="text-sm">
          <Link href="/confidential" className="underline underline-offset-4">
            {openCount > 0
              ? `${openCount} open case on this tenancy`
              : `${totalCount} closed case on this tenancy`}
          </Link>
        </p>
      )}

      <FormAlerts state={state} />

      <details className="rounded-md border p-3">
        <summary className="min-h-11 cursor-pointer text-sm font-medium">
          Open a confidential case
        </summary>
        <form action={submit} className="mt-3 flex flex-col gap-4">
          <input type="hidden" name="leaseId" value={leaseId} />

          <TextareaField
            label="What is going on"
            name="summary"
            required
            rows={4}
            idPrefix="open-confidential"
            error={errors.summary}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Name of the restricted party"
              name="restrictedPartyName"
              idPrefix="open-confidential"
              error={errors.restrictedPartyName}
              hint="Leave blank if there is nobody to name yet."
            />
            <SelectField
              label="Are they on this tenancy?"
              name="restrictedPartyTenantId"
              idPrefix="open-confidential"
              options={[
                { value: '', label: 'No — not on the lease' },
                ...tenantOptions.map((t) => ({ value: t.id, label: t.label })),
              ]}
            />
          </div>

          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="text-sm font-medium">Documentation</legend>
            <p className="text-sm">{DOCUMENTATION_IS_NOT_STORED}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="What you were shown"
                name="documentationType"
                idPrefix="open-confidential"
                error={errors.documentationType}
                options={[
                  { value: '', label: 'Nothing yet' },
                  ...Object.entries(DOCUMENTATION_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
              <TextField
                label="Date you were shown it"
                name="documentedOn"
                type="date"
                max={today}
                idPrefix="open-confidential"
                error={errors.documentedOn}
              />
            </div>
          </fieldset>

          <SubmitButton label="Open the case" />
        </form>
      </details>
    </section>
  )
}
