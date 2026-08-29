'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import {
  BIFURCATION_IS_NOT_AN_EVICTION,
  DOCUMENTATION_IS_NOT_STORED,
  DOCUMENTATION_LABELS,
  EARLY_TERMINATION_LIABILITY_NOTE,
} from '@rental/core/confidential'
import { friendlyBusinessDate } from '@rental/core/scheduling'
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
                ? `${DOCUMENTATION_LABELS[documentationType as keyof typeof DOCUMENTATION_LABELS] ?? documentationType} — ${documentedOn ? friendlyBusinessDate(documentedOn) : 'date not recorded'} (${documentationSeenBy ?? 'unknown'})`
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

      {/* R-091c. RENDERED OUTSIDE THE ordered/not-ordered branch, so it
          survives the `revalidatePath` that flips this panel the moment the
          re-key lands. This component stays mounted across that swap, so its
          own action state does too - unlike the door-codes panel, where the
          form subcomponent is what unmounts and the code has to be read
          before it does. */}
      {state.strandedNames && (
        <div className="flex flex-col gap-1 rounded-md border border-red-300 p-3 text-sm text-red-800">
          <p className="font-medium">
            {state.strandedNames.join(', ')} {state.strandedNames.length === 1 ? 'has' : 'have'} no
            working door code.
          </p>
          <p>
            The old codes were pulled but the lock would not accept a replacement. Until this is
            fixed they cannot get into their own home — ring them now, and get somebody to the
            property or issue a code from the tenancy once the lock answers.
          </p>
        </div>
      )}

      {state.newDoorCodes && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm font-medium">New door codes</p>
          {/* Shown once, here, because the person who ordered this may have
              the tenant in front of them or on the phone right now. Reading
              one back afterwards is a separate, logged act. */}
          <ul className="flex flex-col gap-1">
            {state.newDoorCodes.map((entry) => (
              <li key={entry.name} className="text-sm">
                {entry.name}: <span className="font-mono text-lg tracking-[0.2em]">{entry.code}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            The old ones no longer open the door. Give these out now — they are shown once.
          </p>
        </div>
      )}

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
          {/* R-091c. The one exception to the sentence above, and it has to
              be next to it or the two readings fight. */}
          <p className="text-sm">
            A smart lock is the exception: door codes on this unit are revoked at the device
            straight away, and everybody still on the tenancy gets a new one, shown here once.
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

/**
 * The statutory early-termination right (R-091b).
 *
 * NEUTRAL LABELS, LIKE EVERY OTHER PANEL HERE. "Early termination", "written
 * notice", "where they want the deposit sent". And the field names are chosen
 * against the rest of this page as well as against themselves — `/leases/[id]`
 * has cost three items a strict-mode collision by not doing that, and this
 * page is heading the same way.
 */
export function EarlyTerminationPanel({
  recorded,
  effectiveOn,
  hasDocumentation,
  today,
  action,
}: {
  recorded: boolean
  effectiveOn: string | null
  hasDocumentation: boolean
  today: string
  action: Action
}) {
  const [state, submit] = useActionState<ConfidentialFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="early-termination" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="early-termination" className="text-lg font-semibold">
        Ending the tenancy early
      </h2>
      <FormAlerts state={state} />
      <LiveRegion>
        {recorded && (
          <p className="text-sm">
            Recorded. The tenancy ends on {effectiveOn && friendlyBusinessDate(effectiveOn)}. On the tenancy itself this is an
            ordinary tenant-given notice and says nothing more.
          </p>
        )}
      </LiveRegion>

      {!recorded && (
        <form action={submit} className="flex flex-col gap-3">
          <p className="text-sm">
            Where the state grants it, a tenant may end the tenancy early without penalty. The
            date is computed from that state&rsquo;s rule — it is not typed, and this
            state&rsquo;s ordinary notice period does not apply to it.
          </p>
          <p className="text-sm">{EARLY_TERMINATION_LIABILITY_NOTE}</p>
          {/* Documentation gates the statutory right and nothing else (D-108).
              Said here rather than discovered at the refusal, because an
              operator who reads "documentation required" on this page will
              reasonably think it gates the lock change too — and it never
              did. */}
          {!hasDocumentation && (
            <p className="text-sm font-medium">
              Nothing is recorded on this case about what you were shown, and the statutory
              right is the one thing that turns on it. Record it above first. Nothing else on
              this page waits on it.
            </p>
          )}
          <TextField
            label="Date they gave written notice"
            name="deliveredOn"
            type="date"
            required
            max={today}
            idPrefix="early-termination"
            error={errors.deliveredOn}
          />
          <TextField
            label="Where to send the deposit disposition"
            name="forwardingAddress"
            idPrefix="early-termination"
            error={errors.forwardingAddress}
            hint="Optional, and it goes on the tenancy where the ordinary disposition reads it. Leave it blank if a forwarding address is itself something they would rather not put on file."
          />
          <SubmitButton label="Record the early termination" />
        </form>
      )}
    </section>
  )
}

/**
 * Removing the restricted party from the tenancy (R-091b).
 *
 * THE PANEL SAYS WHAT THIS IS NOT, prominently, because the failure it is
 * guarding against is an operator who reads "remove them from the lease" as
 * "get them out of the house".
 */
export function RemovePartyPanel({
  sent,
  changeId,
  restrictedPartyName,
  restrictedPartyOnLease,
  today,
  action,
}: {
  sent: boolean
  changeId: string | null
  restrictedPartyName: string | null
  restrictedPartyOnLease: boolean
  today: string
  action: Action
}) {
  const [state, submit] = useActionState<ConfidentialFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="remove-party" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="remove-party" className="text-lg font-semibold">
        Taking the restricted party off the tenancy
      </h2>
      <FormAlerts state={state} />

      {sent ? (
        <p className="text-sm">
          An amendment was sent as change {changeId?.slice(-6)}. It is on the tenancy like any
          other change of occupants, and it carries no reason beyond a statutory one. Everyone
          else on the lease signs it; the person being removed is not asked and is not sent a
          link. It applies when the last signature lands.
        </p>
      ) : !restrictedPartyOnLease ? (
        <p className="text-sm">
          This case does not name the restricted party as somebody who is on the tenancy, so
          there is nothing here to amend. If they are on it, name them on the case above.
        </p>
      ) : (
        <form action={submit} className="flex flex-col gap-3">
          <p className="text-sm">{BIFURCATION_IS_NOT_AN_EVICTION}</p>
          <p className="text-sm">
            This sends the same lease amendment the tenancy&rsquo;s own panel would, with one
            difference: {restrictedPartyName} is left off the signing list altogether. The
            change records that a statute excused the signature, and says nothing else — not on
            the lease page, not in the document, and not in the audit trail.
          </p>
          <TextField
            label="Date the removal takes effect"
            name="effectiveOn"
            type="date"
            required
            defaultValue={today}
            idPrefix="remove-party"
            error={errors.effectiveOn}
            hint="Printed on the amendment. The change itself applies when the last signature lands, never on a timer."
          />
          <SubmitButton label="Send the amendment without their signature" />
        </form>
      )}
    </section>
  )
}
