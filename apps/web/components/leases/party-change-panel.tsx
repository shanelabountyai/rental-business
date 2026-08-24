'use client'

import { useActionState } from 'react'
import { FormAlerts, LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, TextField, TextareaField } from '@/components/form/field.tsx'
import type { PartyChangeFormState } from '@/lib/leases/party-change-builder.ts'

// Roommate changes and lease assignment (RISK-10, R-090).
//
// LABELS ARE DELIBERATELY LONG AND SPECIFIC. `/leases/[id]` now carries a
// dozen panels and CLAUDE.md records four accessible-name collisions in three
// consecutive items - `getByLabel` is a case-insensitive SUBSTRING match, so
// this panel's heading is "Roommate changes and assignment" rather than the
// obvious "Change who is on this lease", which contains R-033's existing
// "Who is on this lease" whole.

type Action = (state: PartyChangeFormState, formData: FormData) => Promise<PartyChangeFormState>

export interface PartyChangeSignerView {
  id: string
  name: string
  role: string
  status: string
  signedAt: string | null
}

export interface PartyChangeView {
  id: string
  status: string
  effectiveOn: string
  reason: string
  leavingNames: readonly string[]
  joiningNames: readonly string[]
  voidReason: string | null
  draftDocumentId: string | null
  executedDocumentId: string | null
  signers: readonly PartyChangeSignerView[]
}

const SIGNER_WORDS: Record<string, string> = {
  PENDING: 'Not sent yet',
  SENT: 'Link sent',
  VIEWED: 'Opened it',
  SIGNED: 'Signed',
  DECLINED: 'Declined',
}

function partiesLine(change: PartyChangeView): string {
  const parts = [
    change.leavingNames.length > 0 ? `${change.leavingNames.join(', ')} leaving` : null,
    change.joiningNames.length > 0 ? `${change.joiningNames.join(', ')} joining` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

export function PartyChangePanel({
  canStart,
  leaseIsRunning,
  currentTenants,
  screenedApplicants,
  changes,
  today,
  startAction,
  voidAction,
}: {
  canStart: boolean
  leaseIsRunning: boolean
  currentTenants: readonly { leaseTenantId: string; name: string }[]
  screenedApplicants: readonly { id: string; name: string; detail: string }[]
  changes: readonly PartyChangeView[]
  today: string
  startAction: Action
  voidAction: Action
}) {
  const [startState, start] = useActionState<PartyChangeFormState, FormData>(startAction, {})
  const [voidState, withdraw] = useActionState<PartyChangeFormState, FormData>(voidAction, {})
  const errors = startState.fieldErrors ?? {}
  const pending = changes.find((c) => c.status === 'PENDING_SIGNATURE') ?? null
  const groupError = errors.parties ?? errors.incoming ?? errors.outgoing ?? errors.lease ?? null

  return (
    <section aria-labelledby="party-change" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="party-change" className="text-lg font-semibold">
        Roommate changes and assignment
      </h2>
      <p className="text-muted-foreground text-sm">
        A change of occupants keeps the same lease, so the ledger, the rent and the deposit
        carry straight through. The security deposit stays with the unit until the last
        occupant has moved out — a departing roommate settles their share with the people
        staying, not with the landlord.
      </p>

      <FormAlerts state={startState} />
      <FormAlerts state={voidState} />

      <LiveRegion>
        {startState.warnings && startState.warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border p-3 text-sm">
            {startState.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </LiveRegion>

      {changes.length > 0 && (
        <ul className="flex flex-col divide-y text-sm">
          {changes.map((change) => (
            <li key={change.id} className="flex flex-col gap-1 py-3">
              <span className="font-medium">
                {partiesLine(change) || 'No parties recorded'} — effective {change.effectiveOn}
              </span>
              <span className="text-muted-foreground text-xs">
                {change.status === 'PENDING_SIGNATURE'
                  ? 'Out for signature'
                  : change.status === 'COMPLETED'
                    ? 'Signed by everybody and applied'
                    : `Withdrawn — ${change.voidReason ?? 'no reason recorded'}`}
              </span>
              <span className="text-muted-foreground text-xs">{change.reason}</span>
              {change.signers.length > 0 && (
                <ul className="text-muted-foreground flex flex-col text-xs">
                  {change.signers.map((signer) => (
                    <li key={signer.id}>
                      {signer.name} ({signer.role.toLowerCase()}) —{' '}
                      {SIGNER_WORDS[signer.status] ?? signer.status}
                      {signer.signedAt ? ` ${signer.signedAt}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {(change.executedDocumentId ?? change.draftDocumentId) && (
                <a
                  href={`/documents/${change.executedDocumentId ?? change.draftDocumentId}/download`}
                  className="w-fit text-sm underline underline-offset-4"
                >
                  {change.executedDocumentId
                    ? 'Download the signed amendment'
                    : 'Download the unsigned amendment'}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      {canStart && pending && (
        <form action={withdraw} className="flex flex-col gap-3 rounded-md border p-3">
          <input type="hidden" name="changeId" value={pending.id} />
          <TextareaField
            label="Why is this amendment being withdrawn?"
            name="reason"
            required
            idPrefix="party-change-void"
            rows={2}
          />
          <SubmitButton label="Withdraw this amendment" />
        </form>
      )}

      {canStart && !pending && leaseIsRunning && (
        <form action={start} className="flex flex-col gap-4 rounded-md border p-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Who is leaving</legend>
            {currentTenants.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nobody is on this lease.</p>
            ) : (
              currentTenants.map((tenant) => (
                <CheckboxField
                  key={tenant.leaseTenantId}
                  label={`${tenant.name} is leaving`}
                  name="outgoingLeaseTenantId"
                  value={tenant.leaseTenantId}
                />
              ))
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Who is joining</legend>
            {screenedApplicants.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nobody is available to add. A replacement joins through an application that has
                been screened and decided, the same as any other applicant — start one from the
                property&rsquo;s listing first.
              </p>
            ) : (
              screenedApplicants.map((applicant) => (
                <CheckboxField
                  key={applicant.id}
                  label={`${applicant.name} is joining`}
                  name="incomingApplicantId"
                  value={applicant.id}
                  hint={applicant.detail}
                />
              ))
            )}
          </fieldset>

          <TextField
            label="The change takes effect on"
            name="effectiveOn"
            type="date"
            required
            defaultValue={today}
            idPrefix="party-change"
            error={errors.effectiveOn}
            hint="Printed on the amendment. Everyone stays on the lease until the last signature lands, whatever this date says."
          />

          <TextareaField
            label="Why are the occupants changing?"
            name="reason"
            required
            rows={2}
            idPrefix="party-change"
            error={errors.reason}
          />

          {startState.warnings && startState.warnings.length > 0 && (
            <CheckboxField
              label="I have read the warning above and want to send this anyway"
              name="acknowledgeWarnings"
            />
          )}

          {/* The two checkbox groups and the lease itself have no single
              field to hang a FieldError on, so their messages land here.
              LiveRegion, never a hand-rolled aria-live: R-101's fix was that
              the region has to exist BEFORE the text arrives, and this is
              exactly the shape that got it wrong 49 times. */}
          <LiveRegion assertive>
            {groupError && <p className="text-sm">{groupError}</p>}
          </LiveRegion>

          <SubmitButton label="Send the amendment to everybody" />
        </form>
      )}

      {canStart && !pending && !leaseIsRunning && (
        <p className="text-muted-foreground text-sm">
          Occupants can only be changed on a running tenancy.
        </p>
      )}
    </section>
  )
}
