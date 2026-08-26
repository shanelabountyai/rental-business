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
///
/// `fileName` is in the button's own name and the select's own label, and that
/// is a different bug from the id one above (R-115). Every row rendered
/// "Reason for deleting" and "Delete", so a screen-reader user listing this
/// panel's controls heard "Delete" once per document with nothing to tell them
/// apart - on the destructive control, where being one row out is the whole
/// cost. A unique id is a correctness property and a distinguishable name is a
/// usability one; the `rowId` machinery solved the first and stopped there.
export function DeleteForm({
  action,
  rowId,
  fileName,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  rowId: string
  fileName: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const selectId = `field-reasonCode-${rowId}`

  return (
    <form action={formAction} className="flex items-center gap-2">
      <FormAlerts state={state} />
      <label className="sr-only" htmlFor={selectId}>
        Reason for deleting {fileName}
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
        className="focus-visible:ring-ring min-h-9 rounded-md border border-red-300 px-3 py-1 text-sm font-medium text-red-800 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {/* VISIBLE "Delete", accessible name "Delete {fileName}". The
            filename in the visible label would print it three times in a row
            that is already showing it, and a list of twenty documents is the
            case this panel is for. 2.5.3 wants the visible label CONTAINED in
            the accessible name, which this is. */}
        Delete<span className="sr-only"> {fileName}</span>
      </button>
    </form>
  )
}
