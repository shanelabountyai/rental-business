'use client'

import { UTILITIES, UTILITY_PAYERS } from '@rental/core/leases'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, SelectField, TextField } from '@/components/form/field.tsx'
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
  requireFullBalance?: boolean
  depositArrangement?: string
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
  const retaliation = state.needsRetaliationAck
  // Only populated on the retaliation early return (see LeaseFormState's own
  // comment on `values`) - `?? defaults?.x` for every OTHER validation
  // failure, which already re-renders from the lease's last-saved terms the
  // same way this form always has.
  const echoed = state.values ?? {}

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
            <p className="text-sm text-amber-800">
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
          defaultValue={echoed.startsOn || defaults?.startsOn}
          key={`starts-${echoed.startsOn ?? ''}`}
          error={errors.startsOn}
        />
        <TextField
          label={isMonthToMonth ? 'Ends on (not used)' : 'Ends on'}
          name="endsOn"
          type="date"
          required={!isMonthToMonth}
          idPrefix="lease"
          defaultValue={isMonthToMonth ? '' : echoed.endsOn || defaults?.endsOn}
          key={`ends-${echoed.endsOn ?? ''}`}
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
          defaultValue={echoed.rentDollars || defaults?.rentDollars}
          key={`rent-${echoed.rentDollars ?? ''}`}
          error={errors.rentDollars}
        />
        {/* THE ARRANGEMENT SITS BESIDE THE AMOUNT, not in some other section,
            because the two contradict each other in a way that only shows up
            at move-out: a surety bond recorded with a cash amount sends
            somebody hunting for money nobody ever collected, and a cash
            deposit recorded as a bond loses a liability the owner is holding.
            Both the form and a database CHECK refuse the combination. */}
        <SelectField
          label="Deposit type"
          name="depositArrangement"
          idPrefix="lease"
          defaultValue={echoed.depositArrangement || defaults?.depositArrangement || 'CASH'}
          key={`deposit-type-${echoed.depositArrangement ?? ''}`}
          error={errors.depositArrangement}
          options={[
            { value: 'CASH', label: 'Cash deposit held' },
            { value: 'SURETY_BOND', label: 'Surety bond — no cash held' },
            { value: 'NONE', label: 'No deposit' },
          ]}
        />
        <TextField
          label="Deposit held (dollars)"
          name="depositDollars"
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          idPrefix="lease"
          defaultValue={echoed.depositDollars || defaults?.depositDollars}
          key={`deposit-${echoed.depositDollars ?? ''}`}
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
          defaultValue={echoed.nsfFeeDollars || defaults?.nsfFeeDollars}
          key={`nsf-${echoed.nsfFeeDollars ?? ''}`}
          error={errors.nsfFeeDollars}
        />
      </div>

      {/* OFF by default, and it should stay that way for most tenancies. D-29
          makes partial payments a property of the collection method; this
          overrides it, and the case it exists for is narrow - a tenant on
          invoicing because they have no card, whose payment plan has already
          failed once. Refusing a part payment from somebody trying to pay
          something is usually the wrong move. */}
      <CheckboxField
        label="Refuse part payments on this lease"
        name="requireFullBalance"
        defaultChecked={defaults?.requireFullBalance}
        hint="Only the full outstanding balance will be accepted. Most leases should leave this off — a tenant paying something is better than a tenant paying nothing."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Rent due on day"
          name="rentDueDay"
          type="number"
          min="1"
          max="28"
          inputMode="numeric"
          idPrefix="lease"
          defaultValue={echoed.rentDueDay || defaults?.rentDueDay || '1'}
          key={`due-day-${echoed.rentDueDay ?? ''}`}
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
            defaultValue={echoed.mtmRentDollars || defaults?.mtmRentDollars}
            key={`mtm-${echoed.mtmRentDollars ?? ''}`}
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

      {retaliation && (
        <div className="flex flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
          <p className="text-sm font-medium">
            {retaliation.daysAgo} day{retaliation.daysAgo === 1 ? '' : 's'} after this
            tenant&rsquo;s {retaliation.category} complaint ({retaliation.occurredOn}) — inside
            the {retaliation.windowDays}-day retaliation-presumption window
          </p>
          <p className="text-muted-foreground text-sm">
            You can go ahead, but the business reason is recorded permanently and is what
            this increase would be defended with.
          </p>
          <TextField
            label="Why are you raising rent now?"
            name="retaliationReason"
            idPrefix="lease"
            required
            error={errors.retaliationReason}
          />
        </div>
      )}

      <SubmitButton label={retaliation ? 'Save anyway, with this reason' : submitLabel} />
    </form>
  )
}
