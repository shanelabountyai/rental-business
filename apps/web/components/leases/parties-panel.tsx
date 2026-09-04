'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextareaField, TextField } from '@/components/form/field.tsx'
import type { LeaseFormState } from '@/lib/leases/actions.ts'
import type { PartyChangeFormState } from '@/lib/leases/party-change-builder.ts'

// The people on a lease (LEASE-06, R-033).
//
// TWO DISTINCT ROLES, rendered as two distinct lists rather than one list
// with a role column. An occupant is jointly liable AND lives there AND
// reaches the tenant portal; a guarantor is liable and nothing else - no
// portal, no maintenance, no comms. That is not a variation on one thing,
// and showing them as one list invites treating them as one thing.

type Action = (state: LeaseFormState, formData: FormData) => Promise<LeaseFormState>
type ReleaseAction = (
  state: PartyChangeFormState,
  formData: FormData,
) => Promise<PartyChangeFormState>

export interface PartyView {
  id: string
  name: string
  contact: string
  isPrimary?: boolean
}

export interface GuarantorView extends PartyView {
  /// R-165. Bound to this guarantor's id server-side - see the lease page's
  /// own comment on why the bind cannot happen in this client component.
  releaseAction: ReleaseAction
}

export function PartiesPanel({
  tenants,
  guarantors,
  selectableTenants,
  canWrite,
  leaseIsRunning,
  today,
  addTenant,
  removeTenant,
  addGuarantor,
}: {
  tenants: readonly PartyView[]
  guarantors: readonly GuarantorView[]
  selectableTenants: readonly { id: string; label: string }[]
  canWrite: boolean
  /// R-165: release goes through the same "only a running tenancy" rule as
  /// every other party change - hidden rather than shown-and-refused, same
  /// posture as PartyChangePanel's own `canStart`.
  leaseIsRunning: boolean
  today: string
  addTenant: Action
  removeTenant: Action
  addGuarantor: Action
}) {
  const [addState, addAction] = useActionState<LeaseFormState, FormData>(addTenant, {})
  const [removeState, removeAction] = useActionState<LeaseFormState, FormData>(
    removeTenant,
    {},
  )
  const [guarantorState, guarantorAction] = useActionState<LeaseFormState, FormData>(
    addGuarantor,
    {},
  )
  const guarantorErrors = guarantorState.fieldErrors ?? {}

  return (
    <section aria-labelledby="parties" className="flex flex-col gap-5 border-t pt-4">
      <h2 id="parties" className="text-lg font-semibold">
        Who is on this lease
      </h2>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Occupants</h3>
        <FormAlerts state={addState} />
        <FormAlerts state={removeState} />
        {tenants.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nobody yet. A lease cannot go live without at least one person on it.
          </p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {tenants.map((tenant) => (
              <li
                key={tenant.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex flex-col">
                  <span>
                    {tenant.name}
                    {tenant.isPrimary && (
                      <span className="text-muted-foreground"> · primary</span>
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs">{tenant.contact}</span>
                </span>
                {canWrite && (
                  <form action={removeAction}>
                    <input type="hidden" name="leaseTenantId" value={tenant.id} />
                    {/* NAMES WHO (R-116). One renders per occupant, so a
                        screen-reader user heard "Remove, Remove, Remove" with
                        no way to tell which press took somebody off the
                        tenancy. `sr-only`, because the row prints the name
                        already. */}
                    <button
                      type="submit"
                      className="focus-visible:ring-ring border-input min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                    >
                      Remove<span className="sr-only"> {tenant.name} from the lease</span>
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && selectableTenants.length > 0 && (
          <form action={addAction} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <SelectField
                label="Add somebody to the lease"
                name="tenantId"
                required
                idPrefix="party"
                options={selectableTenants.map((t) => ({ value: t.id, label: t.label }))}
              />
            </div>
            {/* NOT A BARE "Add" (R-116). `/leases/[id]` also carries "Add
                guarantor" and "Add this charge", and a one-word name that is
                a substring of two others identifies nothing - by ear or to a
                locator. */}
            <SubmitButton label="Add to the lease" />
          </form>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Guarantors</h3>
        <p className="text-muted-foreground text-xs">
          Financially liable, and nothing else — a guarantor never gets portal
          access to maintenance or messages.
        </p>
        <FormAlerts state={guarantorState} />
        {guarantors.length === 0 ? (
          <p className="text-muted-foreground text-sm">None.</p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {guarantors.map((guarantor) => (
              <GuarantorRow
                key={guarantor.id}
                guarantor={guarantor}
                canRelease={canWrite && leaseIsRunning}
                today={today}
              />
            ))}
          </ul>
        )}

        {canWrite && (
          <details className="rounded-md border p-3">
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
              Add a guarantor
            </summary>
            <form action={guarantorAction} className="mt-3 flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="First name"
                  name="firstName"
                  required
                  idPrefix="guarantor"
                  error={guarantorErrors.firstName}
                />
                <TextField
                  label="Last name"
                  name="lastName"
                  required
                  idPrefix="guarantor"
                  error={guarantorErrors.lastName}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Email"
                  name="email"
                  type="email"
                  idPrefix="guarantor"
                  error={guarantorErrors.email}
                />
                <TextField
                  label="Phone"
                  name="phone"
                  idPrefix="guarantor"
                  error={guarantorErrors.phone}
                />
              </div>
              <SubmitButton label="Add guarantor" />
            </form>
          </details>
        )}
      </div>
    </section>
  )
}

/// Its own component, not inlined in the `.map()` above - `useActionState`
/// is a hook, and calling one per guarantor inside a loop is the rules-of-
/// hooks violation that a fixed-count-per-render component avoids.
function GuarantorRow({
  guarantor,
  canRelease,
  today,
}: {
  guarantor: GuarantorView
  canRelease: boolean
  today: string
}) {
  const [state, action] = useActionState<PartyChangeFormState, FormData>(
    guarantor.releaseAction,
    {},
  )
  const errors = state.fieldErrors ?? {}

  return (
    <li className="flex flex-col gap-2 py-2">
      <span className="flex flex-col">
        <span>{guarantor.name}</span>
        <span className="text-muted-foreground text-xs">{guarantor.contact}</span>
      </span>

      {canRelease && (
        <details className="rounded-md border p-3">
          {/* NAMES WHO (R-116) - "Release" alone is a substring of nothing
              else on this page today, but a second guarantor row would make
              every summary read identically to a screen-reader user
              navigating by heading. */}
          <summary className="min-h-11 cursor-pointer text-sm font-medium">
            Release {guarantor.name} as guarantor
          </summary>
          <form action={action} className="mt-3 flex flex-col gap-3">
            <FormAlerts state={state} />
            <TextField
              label="Released effective"
              name="effectiveOn"
              type="date"
              required
              defaultValue={today}
              idPrefix={`guarantor-release-${guarantor.id}`}
              error={errors.effectiveOn}
              hint="Printed on the amendment. The guarantee stays in force for everything that accrued before this date."
            />
            <TextareaField
              label="Why is this guarantee ending?"
              name="reason"
              required
              rows={2}
              idPrefix={`guarantor-release-${guarantor.id}`}
              error={errors.reason}
            />
            <SubmitButton label="Send for signature" />
          </form>
        </details>
      )}
    </li>
  )
}
