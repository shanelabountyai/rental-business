'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { VendorFormState } from '@/lib/vendors/staff-actions.ts'

const METHOD_OPTIONS = [
  { value: 'CHECK', label: 'Check' },
  { value: 'ACH', label: 'ACH' },
  { value: 'CARD', label: 'Card' },
  { value: 'CASH', label: 'Cash' },
  { value: 'OTHER', label: 'Other' },
]

/// MAINT-09's vendor-visible "received → approved → paid" status, on the
/// STAFF side - the vendor's own portal shows the identical
/// `invoiceLifecycleStatus()` read, so the two can never disagree.
export function InvoiceStatusPanel({
  statusLabel,
  canMarkPaid,
  markPaidAction,
}: {
  statusLabel: string
  canMarkPaid: boolean
  markPaidAction?: (state: VendorFormState, formData: FormData) => Promise<VendorFormState>
}) {
  const [state, formAction] = useActionState<VendorFormState, FormData>(
    markPaidAction ?? (async (previous) => previous),
    {},
  )

  return (
    <section aria-labelledby="invoice-status" className="flex flex-col gap-3 rounded-md border p-4">
      <h2 id="invoice-status" className="text-sm font-semibold">
        Invoice status
      </h2>
      <p className="text-sm">{statusLabel}</p>
      {canMarkPaid && (
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <FormAlerts state={state} />
          <SelectField
            label="Paid by"
            name="invoicePaymentMethod"
            idPrefix="invoice-paid"
            required
            error={state.fieldErrors?.invoicePaymentMethod}
            options={METHOD_OPTIONS}
          />
          <SubmitButton label="Mark paid" />
        </form>
      )}
    </section>
  )
}
