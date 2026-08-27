'use client'

import { INVOICE_SPLIT_CATEGORIES, invoiceSplitCategoryLabel } from '@rental/core/vendors'
import { useState } from 'react'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/vendor-invoices/actions.ts'

const STARTING_LINES = 3

// PAY-10's form. Three split lines render server-side and submit with no
// JavaScript at all; "Add another line" is an enhancement on top, which is the
// one thing here that legitimately needs hydration. Nothing on first paint
// depends on it (CLAUDE.md: `onClick` is inert until hydration - so nothing
// that must work on first paint may be a click handler).

export function RecordInvoiceForm({
  action,
  entities,
  properties,
  vendors,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  entities: ReadonlyArray<{ id: string; name: string }>
  properties: ReadonlyArray<{ id: string; name: string; legalEntityId: string }>
  vendors: ReadonlyArray<{ id: string; name: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const [lineCount, setLineCount] = useState(STARTING_LINES)
  const errors = state.fieldErrors ?? {}

  const categoryOptions = INVOICE_SPLIT_CATEGORIES.map((category) => ({
    value: category,
    label: invoiceSplitCategoryLabel(category),
  }))

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <FormAlerts state={state} />

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">The bill, as the vendor sent it</legend>
        <SelectField
          label="Legal entity"
          name="legalEntityId"
          idPrefix="inv"
          required
          error={errors.legalEntityId}
          options={entities.map((entity) => ({ value: entity.id, label: entity.name }))}
        />
        <SelectField
          label="Vendor"
          name="vendorId"
          idPrefix="inv"
          required
          error={errors.vendorId}
          options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))}
        />
        <TextField
          label="Invoice number"
          name="invoiceNumber"
          idPrefix="inv"
          required={false}
          error={errors.invoiceNumber}
          hint="As printed. Leave blank if the ticket has none."
        />
        <TextField
          label="Invoice total"
          name="totalDollars"
          idPrefix="inv"
          type="number"
          step="0.01"
          required
          error={errors.totalDollars}
          hint="Whole dollars and cents, exactly as the vendor printed it. The lines below must add up to this."
        />
        <TextField
          label="Invoice date"
          name="invoicedOn"
          idPrefix="inv"
          type="date"
          required
          error={errors.invoicedOn}
        />
        <TextField
          label="Paid on"
          name="paidOn"
          idPrefix="inv"
          type="date"
          required={false}
          error={errors.paidOn}
          hint="Leave blank until it is paid. An unpaid bill is not a cash-basis deduction in any year."
        />
        <SelectField
          label="Paid by"
          name="paymentMethod"
          idPrefix="inv"
          required={false}
          error={errors.paymentMethod}
          options={[
            { value: 'CHECK', label: 'Check' },
            { value: 'ACH', label: 'ACH' },
            { value: 'CARD', label: 'Card' },
            { value: 'CASH', label: 'Cash' },
            { value: 'OTHER', label: 'Other' },
          ]}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">How it splits</legend>
        <p className="text-muted-foreground text-sm">
          One line per property and category. Each category is a Schedule E line, so the split is
          the export mapping — there is nothing else to classify later.
        </p>
        <FieldError id="field-invoice-splits-error" message={errors.splits} />

        {Array.from({ length: lineCount }, (_, index) => (
          // A FIELDSET, NOT A DIV WITH AN <h3> (R-116). Five field names -
          // "Property", "Category", "Amount", "What this line was for",
          // "Work order ID" - repeat once per line, and a heading inside a
          // plain div conveys nothing programmatically about which line a
          // field belongs to. Splitting a $900 bill onto the wrong property
          // is a Schedule E error nobody notices until January. Nested
          // fieldsets are valid; the outer "How it splits" one exists already.
          <fieldset key={index} className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="text-sm font-medium">Line {index + 1}</legend>
            <SelectField
              label="Property"
              name={`splits.${index}.propertyId`}
              idPrefix={`split-${index}`}
              required={false}
              error={errors[`splits.${index}.propertyId`]}
              options={properties.map((property) => ({ value: property.id, label: property.name }))}
            />
            <SelectField
              label="Category"
              name={`splits.${index}.category`}
              idPrefix={`split-${index}`}
              required={false}
              error={errors[`splits.${index}.category`]}
              options={categoryOptions}
            />
            <TextField
              label="Amount"
              name={`splits.${index}.amountDollars`}
              idPrefix={`split-${index}`}
              type="number"
              step="0.01"
              required={false}
              error={errors[`splits.${index}.amountDollars`]}
            />
            <TextField
              label="What this line was for"
              name={`splits.${index}.description`}
              idPrefix={`split-${index}`}
              required={false}
              error={errors[`splits.${index}.description`]}
            />
            <TextField
              label="Work order ID"
              name={`splits.${index}.workOrderId`}
              idPrefix={`split-${index}`}
              required={false}
              error={errors[`splits.${index}.workOrderId`]}
              hint="Optional. Linking the job stops its own invoice amount being deducted as well."
            />
          </fieldset>
        ))}

        <button
          type="button"
          onClick={() => setLineCount((count) => count + 1)}
          className="hover:bg-accent focus-visible:ring-ring w-fit rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          Add another line
        </button>
      </fieldset>

      <TextField label="Notes" name="notes" idPrefix="inv" required={false} error={errors.notes} />
      <SubmitButton label="Record invoice" />
    </form>
  )
}
