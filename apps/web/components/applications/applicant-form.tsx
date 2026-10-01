'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormAlerts, pendingButtonProps, useFormVersion } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import type { ApplicantFormState } from '@/lib/applications/actions.ts'

// One applicant's own section (LEASE-03, R-059) - name, DOB, current
// address, employer and income. TWO submit buttons in ONE form: the
// browser includes only the ACTIVATED button's name=value pair in the
// posted FormData, so `intent` tells the action which was pressed without
// any client-side branching.

function FormButtons() {
  const { pending } = useFormStatus()
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="submit"
        name="intent"
        value="save"
        {...pendingButtonProps(pending)}
        className="border-input hover:bg-secondary focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {pending ? 'Working…' : 'Save progress'}
      </button>
      <button
        type="submit"
        name="intent"
        value="submit"
        {...pendingButtonProps(pending)}
        className={`${SUBMIT_BUTTON_CLASSES} min-h-11 px-4 py-2 text-base`}
      >
        {pending ? 'Working…' : 'Submit'}
      </button>
    </div>
  )
}

export interface ApplicantFormValues {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  dateOfBirth: string | null
  currentAddressLine1: string | null
  currentCity: string | null
  currentState: string | null
  currentPostalCode: string | null
  monthsAtCurrentAddress: number | null
  employerName: string | null
  monthlyIncomeCents: number | null
}

export function ApplicantForm({
  action,
  values,
}: {
  action: (state: ApplicantFormState, formData: FormData) => Promise<ApplicantFormState>
  values: ApplicantFormValues
}) {
  const [state, formAction] = useActionState<ApplicantFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  // What was typed, handed back after a refusal, and the `key` that makes it
  // survive React 19's post-dispatch reset (R-114, `useFormVersion`). Falls
  // back to `values` (this applicant's saved row) when nothing was refused -
  // the ordinary first render, and a successful save's revalidated props.
  const echoed = state.values ?? {}
  const formVersion = useFormVersion(state)

  return (
    <div className="flex flex-col gap-4">
      <FormAlerts state={state} />

      <form key={formVersion} action={formAction} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="First name"
            name="firstName"
            required
            idPrefix="applicant"
            defaultValue={echoed.firstName ?? values.firstName}
            error={errors.firstName}
            autoComplete="given-name"
          />
          <TextField
            label="Last name"
            name="lastName"
            required
            idPrefix="applicant"
            defaultValue={echoed.lastName ?? values.lastName}
            error={errors.lastName}
            autoComplete="family-name"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Email"
            name="email"
            type="email"
            idPrefix="applicant"
            defaultValue={echoed.email ?? values.email ?? undefined}
            error={errors.email}
            hint="Give an email or a phone - at least one."
            autoComplete="email"
          />
          <TextField
            label="Phone"
            name="phone"
            type="tel"
            idPrefix="applicant"
            defaultValue={echoed.phone ?? values.phone ?? undefined}
            autoComplete="tel"
          />
        </div>
        <TextField
          label="Date of birth"
          name="dateOfBirth"
          type="date"
          required
          idPrefix="applicant"
          defaultValue={echoed.dateOfBirth ?? values.dateOfBirth ?? undefined}
          error={errors.dateOfBirth}
          autoComplete="bday"
        />

        <fieldset className="flex flex-col gap-4 border-t pt-4">
          <legend className="text-sm font-semibold">Current address</legend>
          <TextField
            label="Street address"
            name="currentAddressLine1"
            required
            idPrefix="applicant"
            defaultValue={echoed.currentAddressLine1 ?? values.currentAddressLine1 ?? undefined}
            error={errors.currentAddressLine1}
            autoComplete="street-address"
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="City"
              name="currentCity"
              required
              idPrefix="applicant"
              defaultValue={echoed.currentCity ?? values.currentCity ?? undefined}
              error={errors.currentCity}
              autoComplete="address-level2"
            />
            <TextField
              label="State"
              name="currentState"
              required
              idPrefix="applicant"
              defaultValue={echoed.currentState ?? values.currentState ?? undefined}
              error={errors.currentState}
              autoComplete="address-level1"
            />
            <TextField
              label="Postal code"
              name="currentPostalCode"
              required
              idPrefix="applicant"
              defaultValue={echoed.currentPostalCode ?? values.currentPostalCode ?? undefined}
              error={errors.currentPostalCode}
              autoComplete="postal-code"
            />
          </div>
          <TextField
            label="Months at this address"
            name="monthsAtCurrentAddress"
            type="number"
            min="0"
            inputMode="numeric"
            required
            idPrefix="applicant"
            defaultValue={
              echoed.monthsAtCurrentAddress ?? values.monthsAtCurrentAddress ?? undefined
            }
            error={errors.monthsAtCurrentAddress}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-t pt-4">
          <legend className="text-sm font-semibold">Income</legend>
          <TextField
            label="Employer (optional)"
            name="employerName"
            idPrefix="applicant"
            defaultValue={echoed.employerName ?? values.employerName ?? undefined}
          />
          <TextField
            label="Monthly income"
            name="monthlyIncome"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            required
            idPrefix="applicant"
            defaultValue={
              echoed.monthlyIncome ??
              (values.monthlyIncomeCents != null ? values.monthlyIncomeCents / 100 : undefined)
            }
            error={errors.monthlyIncomeCents}
            hint="Before taxes, in dollars."
          />
        </fieldset>

        <FormButtons />
      </form>
    </div>
  )
}
