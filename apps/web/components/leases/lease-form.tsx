'use client'

import { UTILITIES, UTILITY_PAYERS } from '@rental/core/leases'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { LeaseFormState } from '@/lib/leases/actions.ts'

// The lease terms form (LEASE-06, R-033), shared by create and edit.
//
// The month-to-month toggle drives the end-date field CLIENT-SIDE as well as
// server-side, because the two rules are mutually exclusive and discovering
// that after a save is a wasted round trip: a fixed term needs an end date,
// and a month-to-month one must not have one (R-009's auto-make-ready job
// keys on exactly that column, and would flip the unit out from under a
// tenant who still lives there).

const UTILITY_LABELS: Record<string, string> = {
  electricity: 'Electricity',
  gas: 'Gas',
  water: 'Water',
  sewer: 'Sewer',
  trash: 'Trash',
  internet: 'Internet',
  lawn: 'Lawn care',
  pest: 'Pest control',
}

const PAYER_LABELS: Record<string, string> = {
  TENANT: 'Tenant',
  LANDLORD: 'Landlord',
  NOT_APPLICABLE: 'N/A',
}

export interface UnitOption {
  id: string
  name: string
  propertyName: string
  status: string
  marketRentCents: number | null
  /// The tenancy already running on this unit, if any. Shown inline rather
  /// than used to hide the unit: a lease ending next month legitimately
  /// needs next month's lease created now, so the answer to "is this
  /// occupied?" is information, not a filter.
  occupiedUntil: string | null
}

export interface LeaseDefaults {
  unitId?: string
  startsOn?: string
  endsOn?: string
  rentDollars?: string
  depositDollars?: string
  nsfFeeDollars?: string
  rentDueDay?: string
  isMonthToMonth?: boolean
  mtmRentDollars?: string
  utilities?: Record<string, string>
}

export function LeaseForm({
  action,
  units,
  defaults,
  submitLabel,
  showOrigin = false,
}: {
  action: (state: LeaseFormState, formData: FormData) => Promise<LeaseFormState>
  /// Empty on the edit form - the unit is not something a lease moves
  /// between, and offering it would invite exactly that.
  units?: readonly UnitOption[]
  defaults?: LeaseDefaults
  submitLabel: string
  showOrigin?: boolean
}) {
  const [state, formAction] = useActionState<LeaseFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const [isMonthToMonth, setIsMonthToMonth] = useState(defaults?.isMonthToMonth ?? false)
  const [origin, setOrigin] = useState('APPLICATION')

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <FormAlerts state={state} />

      {showOrigin && (
        <fieldset className="flex flex-col gap-2 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">Where did this tenancy come from?</legend>
          {[
            {
              value: 'APPLICATION',
              label: 'A normal application',
              hint: 'Somebody applied, was screened, and signed.',
            },
            {
              value: 'INHERITED',
              label: 'Inherited at acquisition',
              hint: 'It came with the building. There is no application and there never will be.',
            },
          ].map((option) => (
            <label key={option.value} className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="radio"
                name="origin"
                value={option.value}
                checked={origin === option.value}
                onChange={() => setOrigin(option.value)}
                className="mt-1 size-5"
              />
              <span className="flex flex-col">
                <span className="font-medium">{option.label}</span>
                <span className="text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
          {origin === 'INHERITED' && (
            <p className="text-sm text-amber-800 dark:text-amber-200">
              Three things will be flagged as outstanding: confirming these terms
              with the tenant, establishing whether the deposit transferred, and
              capturing condition-as-found photos. Each gets harder every week
              after closing.
            </p>
          )}
        </fieldset>
      )}

      {units && (
        <div className="flex flex-col gap-1.5">
          <SelectField
            label="Unit"
            name="unitId"
            required
            idPrefix="lease"
            defaultValue={defaults?.unitId}
            error={errors.unitId}
            options={units.map((unit) => ({
              value: unit.id,
              label: `${unit.propertyName} — ${unit.name}${
                unit.occupiedUntil ? ` (occupied ${unit.occupiedUntil})` : ''
              }`,
            }))}
          />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Starts on"
          name="startsOn"
          type="date"
          required
          idPrefix="lease"
          defaultValue={defaults?.startsOn}
          error={errors.startsOn}
        />
        <TextField
          label={isMonthToMonth ? 'Ends on (not used)' : 'Ends on'}
          name="endsOn"
          type="date"
          required={!isMonthToMonth}
          idPrefix="lease"
          defaultValue={isMonthToMonth ? '' : defaults?.endsOn}
          error={errors.endsOn}
          hint={
            isMonthToMonth
              ? 'A month-to-month tenancy has no end date — leave this blank.'
              : undefined
          }
        />
      </div>

      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="isMonthToMonth"
          value="yes"
          checked={isMonthToMonth}
          onChange={(event) => setIsMonthToMonth(event.target.checked)}
          className="mt-1 size-5"
        />
        <span className="flex flex-col">
          <span className="font-medium">Month-to-month</span>
          <span className="text-muted-foreground">
            No fixed end date. Common on an inherited tenancy where the original
            term ran out years ago.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Monthly rent (dollars)"
          name="rentDollars"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          required
          idPrefix="lease"
          defaultValue={defaults?.rentDollars}
          error={errors.rentDollars}
        />
        <TextField
          label="Deposit held (dollars)"
          name="depositDollars"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          idPrefix="lease"
          defaultValue={defaults?.depositDollars}
          error={errors.depositDollars}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* BLANK IS THE DEFAULT AND BLANK MEANS NO FEE (R-039a). The hint
            says so out loud because the alternative reading - "they left it
            empty so charge the usual" - is how a product charges a fee the
            tenant never agreed to, which is exactly when it stops being
            enforceable. A state that forbids or caps the fee overrides
            whatever is typed here (D-4), without anybody editing a lease. */}
        <TextField
          label="Returned-payment fee (dollars)"
          name="nsfFeeDollars"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          idPrefix="lease"
          hint="Only if the lease says so. Leave blank for no fee — the state's own cap still applies."
          defaultValue={defaults?.nsfFeeDollars}
          error={errors.nsfFeeDollars}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Rent due on day"
          name="rentDueDay"
          type="number"
          min="1"
          max="28"
          inputMode="numeric"
          idPrefix="lease"
          defaultValue={defaults?.rentDueDay ?? '1'}
          error={errors.rentDueDay}
          hint="1 to 28 — later has no equivalent in February."
        />
        {isMonthToMonth ? null : (
          <TextField
            label="Rent on month-to-month rollover"
            name="mtmRentDollars"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            idPrefix="lease"
            defaultValue={defaults?.mtmRentDollars}
            error={errors.mtmRentDollars}
            hint="Optional. Blank keeps the current rent when the term rolls over."
          />
        )}
      </div>

      <fieldset className="flex flex-col gap-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Who pays which utility</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {UTILITIES.map((utility) => (
            <SelectField
              key={utility}
              label={UTILITY_LABELS[utility] ?? utility}
              name={`utility.${utility}`}
              idPrefix="lease"
              defaultValue={defaults?.utilities?.[utility] ?? 'TENANT'}
              placeholder="—"
              options={UTILITY_PAYERS.map((payer) => ({
                value: payer,
                label: PAYER_LABELS[payer] ?? payer,
              }))}
            />
          ))}
        </div>
      </fieldset>

      <SubmitButton label={submitLabel} />
    </form>
  )
}
