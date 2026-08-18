'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormAlerts } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
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
        disabled={pending}
        className="border-input hover:bg-accent focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-base font-medium disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {pending ? 'Working…' : 'Save progress'}
      </button>
      <button
        type="submit"
        name="intent"
        value="submit"
        disabled={pending}
        className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-base font-medium disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
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

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First name"
          name="firstName"
          required
          idPrefix="applicant"
          defaultValue={values.firstName}
          error={errors.firstName}
        />
        <TextField
          label="Last name"
          name="lastName"
          required
          idPrefix="applicant"
          defaultValue={values.lastName}
          error={errors.lastName}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Email"
          name="email"
          type="email"
          idPrefix="applicant"
          defaultValue={values.email ?? undefined}
          error={errors.email}
          hint="Give an email or a phone - at least one."
        />
        <TextField
          label="Phone"
          name="phone"
          type="tel"
          idPrefix="applicant"
          defaultValue={values.phone ?? undefined}
        />
      </div>
      <TextField
        label="Date of birth"
        name="dateOfBirth"
        type="date"
        required
        idPrefix="applicant"
        defaultValue={values.dateOfBirth ?? undefined}
        error={errors.dateOfBirth}
      />

      <fieldset className="flex flex-col gap-4 border-t pt-4">
        <legend className="text-sm font-semibold">Current address</legend>
        <TextField
          label="Street address"
          name="currentAddressLine1"
          required
          idPrefix="applicant"
          defaultValue={values.currentAddressLine1 ?? undefined}
          error={errors.currentAddressLine1}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="City"
            name="currentCity"
            required
            idPrefix="applicant"
            defaultValue={values.currentCity ?? undefined}
            error={errors.currentCity}
          />
          <TextField
            label="State"
            name="currentState"
            required
            idPrefix="applicant"
            defaultValue={values.currentState ?? undefined}
            error={errors.currentState}
          />
          <TextField
            label="Postal code"
            name="currentPostalCode"
            required
            idPrefix="applicant"
            defaultValue={values.currentPostalCode ?? undefined}
            error={errors.currentPostalCode}
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
          defaultValue={values.monthsAtCurrentAddress ?? undefined}
          error={errors.monthsAtCurrentAddress}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t pt-4">
        <legend className="text-sm font-semibold">Income</legend>
        <TextField
          label="Employer (optional)"
          name="employerName"
          idPrefix="applicant"
          defaultValue={values.employerName ?? undefined}
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
            values.monthlyIncomeCents != null ? values.monthlyIncomeCents / 100 : undefined
          }
          error={errors.monthlyIncomeCents}
          hint="Before taxes, in dollars."
        />
      </fieldset>

      <FormButtons />
    </form>
  )
}
