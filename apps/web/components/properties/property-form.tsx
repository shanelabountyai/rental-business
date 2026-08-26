'use client'

import { COMMON_US_TIMEZONES, US_STATE_OPTIONS } from '@rental/core/property'
import { useActionState, useId, useState } from 'react'
import { FormAlerts } from '@/components/auth-form.tsx'
import { CheckboxField, SelectField, TextareaField, TextField } from '@/components/form/field.tsx'
import { LiveRegion, SubmitButton } from '@/components/auth-form.tsx'
import type { PropertyFormState } from '@/lib/properties/actions.ts'

const PROPERTY_TYPE_OPTIONS = [
  { value: 'SINGLE_FAMILY', label: 'Single-family' },
  { value: 'DUPLEX', label: 'Duplex' },
  { value: 'TRIPLEX', label: 'Triplex' },
  { value: 'FOURPLEX', label: 'Fourplex' },
  { value: 'TOWNHOUSE', label: 'Townhouse' },
  { value: 'CONDO', label: 'Condo' },
  { value: 'MANUFACTURED', label: 'Manufactured' },
]

export interface PropertyDefaults {
  legalEntityId?: string
  name?: string
  propertyType?: string
  timezone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  bedrooms?: number | ''
  bathrooms?: number | ''
  yearBuilt?: number | ''
  acquiredOn?: string
  metro?: string
  tags?: string
  hasPool?: boolean
  hasWellOrSeptic?: boolean
  moldHistoryNotes?: string
  bedbugHistoryNotes?: string
}

/// Converts what the action echoed back (PropertyInput: number|null,
/// string|null) into the shape TextField/SelectField's defaultValue expects
/// (number|'', string|undefined) - the same conversion the edit page already
/// does when loading a Property row into this form.
function defaultsFromSubmitted(
  submitted: NonNullable<PropertyFormState['submitted']>,
): PropertyDefaults {
  return {
    legalEntityId: submitted.legalEntityId || undefined,
    name: submitted.name,
    propertyType: submitted.propertyType || undefined,
    timezone: submitted.timezone,
    addressLine1: submitted.addressLine1,
    addressLine2: submitted.addressLine2 ?? undefined,
    city: submitted.city,
    state: submitted.state || undefined,
    postalCode: submitted.postalCode,
    bedrooms: submitted.bedrooms ?? '',
    bathrooms: submitted.bathrooms ?? '',
    yearBuilt: submitted.yearBuilt ?? '',
    acquiredOn: submitted.acquiredOn ?? undefined,
    metro: submitted.metro ?? undefined,
    tags: submitted.tags?.join(', '),
    hasPool: submitted.hasPool ?? false,
    hasWellOrSeptic: submitted.hasWellOrSeptic ?? false,
    moldHistoryNotes: submitted.moldHistoryNotes ?? undefined,
    bedbugHistoryNotes: submitted.bedbugHistoryNotes ?? undefined,
  }
}

/**
 * Create and edit share this form. On create, the duplicate-address warning
 * (PROP-01) can come back instead of success - the form re-renders with the
 * same values plus a banner and a "Save anyway" control that resubmits with
 * `confirmDuplicate=true`, rather than silently creating a second record or
 * silently blocking a legitimate one (a second unit built at the same street
 * address is real).
 *
 * THE REMOUNT: React resets an uncontrolled <form>'s fields after any action
 * dispatch, success or not - so by the time a validation error or the
 * duplicate warning comes back, the DOM has already forgotten what the user
 * typed. `formVersion` bumps once per response and is used as the form's
 * `key`, forcing React to throw away those now-empty inputs and mount fresh
 * ones whose `defaultValue` comes from `values` below - which is state's
 * echoed-back `submitted`, not the stale DOM.
 *
 * Bumped during render (comparing against a stored previous `state`), not in
 * a useEffect: React's own guidance for "adjust state when a prop/state
 * changes" is to do it inline with this same setState-during-render escape
 * hatch, which - unlike an effect - applies before the browser paints, so
 * there is no visible flash of empty fields between the reset and the
 * repopulation. react-hooks/set-state-in-effect flags the effect-based
 * version for exactly this reason.
 */
export function PropertyForm({
  action,
  submitLabel,
  defaults,
  legalEntities,
  lockEntity,
}: {
  action: (
    state: PropertyFormState,
    formData: FormData,
  ) => Promise<PropertyFormState>
  submitLabel: string
  defaults: PropertyDefaults
  /// Only needed for create - edit does not offer re-parenting to a
  /// different entity in this item (PROP-04 asks for assignment at creation,
  /// not reassignment, and that is a bigger decision than this form should
  /// make casually).
  legalEntities?: readonly { id: string; name: string }[]
  lockEntity?: { id: string; name: string }
}) {
  const [state, formAction] = useActionState<PropertyFormState, FormData>(
    action,
    {},
  )
  const errors = state.fieldErrors ?? {}
  const values = state.submitted
    ? defaultsFromSubmitted(state.submitted)
    : defaults

  // Stable across the remount below, so the hoisted "Save anyway" button can
  // point at the form with `form=`. `useId` rather than a constant: two of
  // these on one page would otherwise share a DOM id.
  const formId = useId()

  const [previousState, setPreviousState] = useState(state)
  const [formVersion, setFormVersion] = useState(0)
  if (state !== previousState) {
    setPreviousState(state)
    setFormVersion((version) => version + 1)
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      {/*
        OUTSIDE THE KEYED <form>, and that is the whole point (R-107b).

        `key={formVersion}` throws the entire form subtree away on every
        action response, so a live region rendered inside it is a NEW NODE
        every time - which is exactly the defect R-101 fixed by mounting the
        regions unconditionally. The remount silently undid that fix on this
        one form. Hoisted here, the regions survive the remount and the text
        arriving in them is a change an assistive technology can report.

        The "Save anyway" button is a submit control for the form below via
        the native `form=` attribute, which is what lets the warning live
        outside the element it submits.
      */}
      <FormAlerts state={state} />

      <LiveRegion assertive>
        {state.duplicateOf && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <p>
              A property called <strong>{state.duplicateOf.name}</strong> at{' '}
              <strong>{state.duplicateOf.addressLine1}</strong> already exists.
              Save anyway if this is genuinely a second, distinct record (a
              second unit at the same street address, for instance).
            </p>
            <button
              type="submit"
              form={formId}
              name="confirmDuplicate"
              value="true"
              className="border-input hover:bg-accent min-h-11 self-start rounded-md border px-4 py-2 text-sm font-medium"
            >
              Save anyway
            </button>
          </div>
        )}
      </LiveRegion>

      <form
        id={formId}
        key={formVersion}
        action={formAction}
        className="flex flex-col gap-5"
      >
        {lockEntity ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Owning entity</span>
            <p className="text-muted-foreground text-sm">{lockEntity.name}</p>
            {/*
              No select is rendered, so nothing would otherwise submit
              legalEntityId - and the shared validator requires it on every
              write. A hidden field keeps validateProperty() identical for
              create and edit rather than making the check conditional on which
              screen is calling it. Controlled (`value`, not `defaultValue`), so
              it is immune to the reset-on-dispatch problem the rest of this
              form works around with a remount.
            */}
            <input type="hidden" name="legalEntityId" value={lockEntity.id} />
          </div>
        ) : (
          <SelectField
            label="Owning entity"
            name="legalEntityId"
            required
            defaultValue={values.legalEntityId}
            error={errors.legalEntityId}
            options={(legalEntities ?? []).map((entity) => ({
              value: entity.id,
              label: entity.name,
            }))}
          />
        )}

        <TextField
          label="Property name"
          name="name"
          required
          defaultValue={values.name}
          error={errors.name}
          hint="How you'll refer to it internally - the street name is fine."
        />

        <SelectField
          label="Property type"
          name="propertyType"
          required
          defaultValue={values.propertyType}
          error={errors.propertyType}
          options={PROPERTY_TYPE_OPTIONS}
        />

        <fieldset className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">Address</legend>
          <TextField
            label="Street address"
            name="addressLine1"
            required
            defaultValue={values.addressLine1}
            error={errors.addressLine1}
          />
          <TextField
            label="Unit / apt (optional)"
            name="addressLine2"
            defaultValue={values.addressLine2}
            error={errors.addressLine2}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TextField
              label="City"
              name="city"
              required
              defaultValue={values.city}
              error={errors.city}
            />
            <SelectField
              label="State"
              name="state"
              required
              defaultValue={values.state}
              error={errors.state}
              options={US_STATE_OPTIONS.map((s) => ({
                value: s.code,
                label: `${s.code} — ${s.name}`,
              }))}
            />
            <TextField
              label="ZIP"
              name="postalCode"
              required
              inputMode="numeric"
              defaultValue={values.postalCode}
              error={errors.postalCode}
            />
          </div>
        </fieldset>

        <TextField
          label="Timezone"
          name="timezone"
          required
          list="timezone-options"
          defaultValue={values.timezone}
          error={errors.timezone}
          hint="Every late fee, reminder and nightly job for this property runs on this clock (not UTC) - get it right."
        />
        <datalist id="timezone-options">
          {COMMON_US_TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value} label={tz.label} />
          ))}
        </datalist>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            label="Bedrooms"
            name="bedrooms"
            type="number"
            inputMode="numeric"
            min={0}
            max={20}
            defaultValue={values.bedrooms}
            error={errors.bedrooms}
          />
          <TextField
            label="Bathrooms"
            name="bathrooms"
            type="number"
            inputMode="decimal"
            min={0}
            max={20}
            step={0.5}
            defaultValue={values.bathrooms}
            error={errors.bathrooms}
          />
          <TextField
            label="Year built"
            name="yearBuilt"
            type="number"
            inputMode="numeric"
            min={1700}
            defaultValue={values.yearBuilt}
            error={errors.yearBuilt}
          />
        </div>

        <TextField
          label="Acquisition date"
          name="acquiredOn"
          type="date"
          defaultValue={values.acquiredOn}
          error={errors.acquiredOn}
        />

        <fieldset className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">Announcement grouping</legend>
          <p className="text-muted-foreground text-sm">
            Used only to target segment announcements — sending one message to
            everyone in a metro, or everyone under a shared tag.
          </p>
          <TextField
            label="Metro (optional)"
            name="metro"
            defaultValue={values.metro}
            error={errors.metro}
            hint="Freeform, e.g. &quot;Dallas-Fort Worth&quot; — spell it the same way across properties so they group together."
          />
          <TextField
            label="Tags (optional)"
            name="tags"
            defaultValue={values.tags}
            error={errors.tags}
            hint="Comma-separated, e.g. &quot;downtown, flood-zone&quot;."
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">Lease addenda triggers</legend>
          <p className="text-muted-foreground text-sm">
            Drives which addenda R-063 attaches when a lease is generated for this
            property (lead-paint disclosure is already covered by year built above,
            and an HOA addendum by whether an HOA record exists).
          </p>
          <CheckboxField label="Has a pool or spa" name="hasPool" defaultChecked={values.hasPool} />
          <CheckboxField
            label="On a well or septic system"
            name="hasWellOrSeptic"
            defaultChecked={values.hasWellOrSeptic}
          />
          <TextareaField
            label="Mold history (optional)"
            name="moldHistoryNotes"
            defaultValue={values.moldHistoryNotes}
            error={errors.moldHistoryNotes}
            hint="Leave blank if there is no known history. Any text here triggers the mold disclosure addendum."
          />
          <TextareaField
            label="Bed bug history (optional)"
            name="bedbugHistoryNotes"
            defaultValue={values.bedbugHistoryNotes}
            error={errors.bedbugHistoryNotes}
            hint="Leave blank if there is no known history. Any text here triggers the bed bug disclosure addendum."
          />
        </fieldset>

        <SubmitButton label={submitLabel} />
      </form>
    </div>
  )
}
