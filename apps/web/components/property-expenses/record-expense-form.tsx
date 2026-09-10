'use client'

import { PROPERTY_EXPENSE_CATEGORIES, SCHEDULE_E, WHOLE_ENTITY_OPTION } from '@rental/core/tax'
import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import {
  CheckboxField,
  FieldError,
  SelectField,
  TextField,
} from '@/components/form/field.tsx'
import type { FormState } from '@/lib/property-expenses/actions.ts'

// R-193's form. Nothing here needs hydration: a real <form action>, so it
// works on first paint.

export function RecordExpenseForm({
  action,
  entities,
  properties,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  entities: ReadonlyArray<{ id: string; name: string }>
  properties: ReadonlyArray<{ id: string; name: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <p className="text-muted-foreground text-sm">
        A bill a vendor sent belongs on{' '}
        <Link href="/money/vendor-invoices" className="underline underline-offset-2">
          vendor invoices
        </Link>{' '}
        instead. Enter each bill in one place only, or it is deducted twice.
      </p>
      <SelectField
        label="Legal entity"
        name="legalEntityId"
        idPrefix="exp"
        required
        error={errors.legalEntityId}
        options={entities.map((entity) => ({ value: entity.id, label: entity.name }))}
      />
      <SelectField
        label="Property"
        name="propertyId"
        idPrefix="exp"
        required
        error={errors.propertyId}
        options={[
          { value: WHOLE_ENTITY_OPTION, label: 'The whole entity' },
          ...properties.map((property) => ({ value: property.id, label: property.name })),
        ]}
      />
      <SelectField
        label="Category"
        name="category"
        idPrefix="exp"
        required
        error={errors.category}
        options={PROPERTY_EXPENSE_CATEGORIES.map((key) => ({
          value: key,
          label: SCHEDULE_E[key].label,
        }))}
      />
      <TextField
        label="What it was"
        name="description"
        idPrefix="exp"
        required
        error={errors.description}
        hint='For example "2026 county tax" or "Landlord policy premium".'
      />
      <TextField
        label="Amount paid"
        name="amountDollars"
        idPrefix="exp"
        type="number"
        step="0.01"
        required
        error={errors.amountDollars}
      />
      <TextField
        label="Paid on"
        name="paidOn"
        idPrefix="exp"
        type="date"
        required
        error={errors.paidOn}
      />
      <CheckboxField
        label="Repeats monthly"
        name="recursMonthly"
        hint="Books the same amount on this day each month until you stop it. A month that has not arrived is never booked."
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="exp-document" className="text-sm font-medium">
          Bill or receipt
        </label>
        <input
          id="exp-document"
          name="document"
          type="file"
          accept="application/pdf,image/*"
          aria-describedby={errors.document ? 'exp-document-error' : undefined}
          className="border-input focus-visible:ring-ring min-h-11 min-w-0 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <FieldError id="exp-document-error" message={errors.document} />
      </div>
      <SubmitButton label="Record expense" />
    </form>
  )
}
