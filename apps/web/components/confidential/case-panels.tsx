'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { DOCUMENTATION_LABELS, DOCUMENTATION_IS_NOT_STORED } from '@rental/core/confidential'
import { FormAlerts, LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { ConfidentialFormState } from '@/lib/confidential/actions.ts'

// The confidential case file (RISK-04, ROLE-05; R-091).
//
// EVERY LABEL ON THIS PAGE IS NEUTRAL. "Restricted party", "what you were
// shown", "how this ended". A screen read over somebody's shoulder in an
// office, or shared to a projector by accident, should not announce what kind
// of case it is - the wording is part of the protection, not decoration on
// top of it.

type Action = (state: ConfidentialFormState, formData: FormData) => Promise<ConfidentialFormState>

export interface TenantOption {
  id: string
  label: string
}

export function CaseDetailsPanel({
  summary,
  restrictedPartyName,
  restrictedPartyTenantId,
  documentationType,
  documentedOn,
  documentationSeenBy,
  tenantOptions,
  closed,
  action,
}: {
  summary: string
  restrictedPartyName: string | null
  restrictedPartyTenantId: string | null
  documentationType: string | null
  documentedOn: string | null
  documentationSeenBy: string | null
  tenantOptions: readonly TenantOption[]
  closed: boolean
  action: Action
}) {
  const [state, submit] = useActionState<ConfidentialFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  if (closed) {
    return (
      <section aria-labelledby="case-details" className="flex flex-col gap-3 border-t pt-4">
        <h2 id="case-details" className="text-lg font-semibold">
          What this case records
        </h2>
        <p className="text-sm whitespace-pre-wrap">{summary}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs">Restricted party</dt>
            <dd>{restrictedPartyName ?? 'Not named'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Documentation seen</dt>
            <dd>
              {documentationType
                ? `${DOCUMENTATION_LABELS[documentationType as keyof typeof DOCUMENTATION_LABELS] ?? documentationType} — ${documentedOn} (${documentationSeenBy ?? 'unknown'})`
                : 'None recorded'}
            </dd>
          </div>
        </dl>
      </section>
    )
  }

  return (
    <section aria-labelledby="case-details" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="case-details" className="text-lg font-semibold">
        What this case records
      </h2>
      <FormAlerts state={state} />
      <form action={submit} className="flex flex-col gap-4">
        <TextareaField
          label="What is going on"
          name="summary"
          required
          rows={4}
          idPrefix="case"
          defaultValue={summary}
          error={errors.summary}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Name of the restricted party"
            name="restrictedPartyName"
            idPrefix="case"
            defaultValue={restrictedPartyName ?? ''}
            error={errors.restrictedPartyName}
            hint="Leave blank if there is nobody to name yet."
          />
          <SelectField
            label="Are they on this tenancy?"
            name="restrictedPartyTenantId"
            idPrefix="case"
            defaultValue={restrictedPartyTenantId ?? ''}
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
              idPrefix="case"
              defaultValue={documentationType ?? ''}
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
              idPrefix="case"
              defaultValue={documentedOn ?? ''}
              error={errors.documentedOn}
            />
          </div>
        </fieldset>

        <SubmitButton label="Save this case" />
      </form>
    </section>
  )
}

export function LockChangePanel({
  ordered,
  workOrderId,
  workOrderStatus,
  action,
}: {
  ordered: boolean
  workOrderId: string | null
  workOrderStatus: string | null
  action: Action
}) {
  const [state, submit] = useActionState<ConfidentialFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="lock-change" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="lock-change" className="text-lg font-semibold">
        Locks and access codes
      </h2>
      <FormAlerts state={state} />

      {ordered ? (
        <p className="text-sm">
          A re-key was ordered as work order{' '}
          <Link href={`/workorders/${workOrderId}`} className="underline underline-offset-4">
            {workOrderId?.slice(-6)}
          </Link>{' '}
          ({workOrderStatus?.toLowerCase().replace(/_/g, ' ')}). The access codes on file for
          this unit were retired at the same time. The work order carries an instruction about
          who may be handed keys and says nothing about why it exists.
        </p>
      ) : (
        <form action={submit} className="flex flex-col gap-3">
          <p className="text-sm">
            This raises an urgent re-key work order for the unit and retires every access code
            on file for it, in one step.
          </p>
          {/* The limit stated where somebody would otherwise stop. Retiring a
              code closes our record so nothing here hands it out again; it
              does not change any lock. The work order does. */}
          <p className="text-sm">
            Retiring a code stops this system handing it out again — to a vendor or to a
            tenant. It does not change any lock. The work order is what makes the door
            different, so it still has to be assigned and done.
          </p>
          <TextField
            label="Who the locksmith should ring if anybody else asks"
            name="callbackLabel"
            required
            idPrefix="lock-change"
            error={errors.callbackLabel}
            hint="A name and a number. It goes on the job as written."
          />
          <SubmitButton label="Order the re-key and retire the codes" />
        </form>
      )}
    </section>
  )
}

export function CloseCasePanel({
  closed,
  closedNote,
  closedOn,
  action,
}: {
  closed: boolean
  closedNote: string | null
  closedOn: string | null
  action: Action
}) {
  const [state, submit] = useActionState<ConfidentialFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="close-case" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="close-case" className="text-lg font-semibold">
        Closing this case
      </h2>
      <LiveRegion>
        {closed && (
          <p className="text-sm">
            Closed {closedOn}. {closedNote}
          </p>
        )}
      </LiveRegion>
      {!closed && (
        <form action={submit} className="flex flex-col gap-3">
          <FormAlerts state={state} />
          <TextareaField
            label="How this case ended"
            name="closedNote"
            required
            rows={3}
            idPrefix="close-case"
            error={errors.closedNote}
            hint="Recorded on the case and in the audit trail. It is the only part of this case that goes into the audit log."
          />
          <SubmitButton label="Close this case" />
        </form>
      )}
    </section>
  )
}
