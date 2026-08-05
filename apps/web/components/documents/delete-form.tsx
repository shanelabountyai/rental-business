'use client'

import { REASON_CODES } from '@rental/core/audit'
import { useActionState } from 'react'
import { FormAlerts } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/documents/actions.ts'

const REASON_LABELS: Record<string, string> = {
  goodwill: 'Goodwill',
  first_occurrence: 'First occurrence',
  billing_error: 'Billing error',
  payment_plan: 'Payment plan',
  hardship: 'Hardship',
  duplicate: 'Duplicate upload',
  owner_directive: 'Owner directive',
  legal_advice: "Counsel's advice",
  emergency: 'Emergency',
  tenant_request: 'Tenant request',
  correction: 'Wrong file / correction',
  other: 'Other',
}

/// A reason is required (REASON_REQUIRED, 'document.delete_marked') - the
/// select is inline rather than a separate confirmation step, since the
/// reason itself already forces a moment's thought before submitting.
///
/// `rowId` disambiguates the id when more than one DeleteForm renders on the
/// same page (one per document in the list) - a bare "field-reasonCode"
/// collided across rows the moment a unit or property had two or more
/// documents, the same duplicate-id class of bug CheckboxField's `value`
/// param and TextField/SelectField's `idPrefix` param both exist to avoid.
export function DeleteForm({
  action,
  rowId,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  rowId: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const selectId = `field-reasonCode-${rowId}`

  return (
    <form action={formAction} className="flex items-center gap-2">
      <FormAlerts state={state} />
      <label className="sr-only" htmlFor={selectId}>
        Reason for deleting
      </label>
      <select
        id={selectId}
        name="reasonCode"
        required
        aria-invalid={Boolean(errors.reasonCode) || undefined}
        defaultValue=""
        className="border-input bg-background focus-visible:ring-ring min-h-9 rounded-md border px-2 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <option value="" disabled>
          Reason…
        </option>
        {REASON_CODES.map((code) => (
          <option key={code} value={code}>
            {REASON_LABELS[code] ?? code}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="min-h-9 rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-800 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none dark:border-red-900 dark:text-red-200 dark:hover:bg-red-950"
      >
        Delete
      </button>
    </form>
  )
}
