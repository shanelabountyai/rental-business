'use client'

import { effectLabels, HOLD_DEFINITIONS, HOLD_TYPES, type HoldType } from '@rental/core/holds'
import { useActionState, useState } from 'react'
import { FormAlerts, LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { HoldFormState } from '@/lib/holds/actions.ts'

// Placing and lifting holds on one tenancy (R-084).
//
// The panel shows LIFTED holds as well as live ones, and that is not
// completeness for its own sake: "was the stay in force on the day that late
// fee was assessed" is the question this record exists to answer, and a
// screen that only shows what is on today cannot answer it.

export interface HoldRow {
  id: string
  type: HoldType
  reason: string
  placedOn: string
  placedByName: string
  liftedOn: string | null
  liftedByName: string | null
  liftReason: string | null
}

function PlaceForm({
  leaseId,
  action,
  availableTypes,
}: {
  leaseId: string
  action: (state: HoldFormState, formData: FormData) => Promise<HoldFormState>
  availableTypes: readonly HoldType[]
}) {
  const [state, formAction] = useActionState<HoldFormState, FormData>(action, {})
  const [type, setType] = useState<HoldType | ''>('')

  if (availableTypes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every hold type is already in force on this tenancy.
      </p>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="leaseId" value={leaseId} />

      <SelectField
        label="Hold type"
        name="type"
        required
        options={availableTypes.map((value) => ({
          value,
          label: HOLD_DEFINITIONS[value].label,
        }))}
        idPrefix="place-hold"
        onChange={(event) => setType(event.target.value as HoldType)}
      />

      {/* WHAT IT WILL ACTUALLY DO, before it is placed. The effects follow
          from the type rather than being ticked, so the person choosing has
          to be able to see what they are choosing — otherwise the config
          that makes this safe is also what makes it opaque.

          IN A LIVE REGION MOUNTED FROM FIRST PAINT (R-116). The sentence
          appears when the type is chosen and says which powers are about to
          be switched off for a tenancy - a screen-reader user picking a type
          was told nothing at all. The region has to be in the tree BEFORE
          the text lands in it, which is R-101's rule for every form error. */}
      <LiveRegion>
        {type && (
          <p className="text-muted-foreground text-sm">
            Switches on: {effectLabels(type).join('; ')}.
            {HOLD_DEFINITIONS[type].liftIsPrivileged &&
              ' Lifting it later needs the protected-hold permission and a second factor.'}
          </p>
        )}
      </LiveRegion>

      {/* NOT "Why (required)" - `payment-hold-panel.tsx` has a field by that
          exact name on this same assembled page (R-116). It now reads like
          the sibling "Why this is being lifted (required)" below, which is
          the wording that already told this file's two forms apart. */}
      <TextField
        label="Why this hold is being placed (required)"
        name="reason"
        required
        hint="Recorded on the audit trail, and shown on the banner to whoever opens this tenancy next. A hold nobody can explain is one nobody will trust."
        idPrefix="place-hold"
      />

      <FormAlerts state={state} />
      <SubmitButton label="Place hold" />
    </form>
  )
}

function LiftForm({
  hold,
  action,
}: {
  hold: HoldRow
  action: (state: HoldFormState, formData: FormData) => Promise<HoldFormState>
}) {
  const [state, formAction] = useActionState<HoldFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="holdId" value={hold.id} />
      <TextField
        label="Why this is being lifted (required)"
        name="liftReason"
        required
        hint="Collection, late fees and access resume from the moment this is saved. This is what answers “on what basis”."
        idPrefix={`lift-${hold.id}`}
      />
      <FormAlerts state={state} />
      <SubmitButton label={`Lift the ${HOLD_DEFINITIONS[hold.type].label.toLowerCase()} hold`} />
    </form>
  )
}

export function HoldsPanel({
  leaseId,
  holds,
  canManage,
  placeAction,
  liftAction,
}: {
  leaseId: string
  holds: readonly HoldRow[]
  /// False for somebody who can read the lease but may not change its holds.
  /// The panel still lists them — that a tenancy is held is operationally
  /// important to anyone reading it — and offers no controls.
  canManage: boolean
  placeAction: (state: HoldFormState, formData: FormData) => Promise<HoldFormState>
  liftAction: (state: HoldFormState, formData: FormData) => Promise<HoldFormState>
}) {
  const active = holds.filter((hold) => hold.liftedOn === null)
  const lifted = holds.filter((hold) => hold.liftedOn !== null)
  const activeTypes = new Set(active.map((hold) => hold.type))

  return (
    <section aria-labelledby="holds" className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="holds" className="text-lg font-semibold">
          Holds
        </h2>
        {active.length > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {active.length} in force
          </span>
        )}
      </div>

      <p className="text-muted-foreground text-sm">
        A hold declares that something about this tenancy has changed in a way
        the automation must not walk into. What each type switches off is
        fixed by the type — it is not something to tick.
      </p>

      {active.length === 0 && lifted.length === 0 && (
        <p className="text-muted-foreground text-sm">No hold has ever been placed here.</p>
      )}

      {active.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {active.map((hold) => (
            <li key={hold.id} className="flex flex-col gap-2 px-4 py-3">
              <span className="font-medium">{HOLD_DEFINITIONS[hold.type].label}</span>
              <span className="text-muted-foreground text-sm">
                Placed {hold.placedOn} by {hold.placedByName} — “{hold.reason}”
              </span>
              <span className="text-muted-foreground text-xs">
                {effectLabels(hold.type).join('; ')}.
              </span>
              {canManage && <LiftForm hold={hold} action={liftAction} />}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <PlaceForm
          leaseId={leaseId}
          action={placeAction}
          availableTypes={HOLD_TYPES.filter((type) => !activeTypes.has(type))}
        />
      )}

      {lifted.length > 0 && (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            {lifted.length} lifted {lifted.length === 1 ? 'hold' : 'holds'}
          </summary>
          <ul className="text-muted-foreground mt-2 flex flex-col gap-2">
            {lifted.map((hold) => (
              <li key={hold.id}>
                {HOLD_DEFINITIONS[hold.type].label} — placed {hold.placedOn} by{' '}
                {hold.placedByName} (“{hold.reason}”), lifted {hold.liftedOn} by{' '}
                {hold.liftedByName} (“{hold.liftReason}”)
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
