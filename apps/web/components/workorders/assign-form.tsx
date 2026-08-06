'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

/// Two independent forms, not one form with a toggle - assigning to staff
/// and assigning to a vendor are different actions with different pickers,
/// and MAINT-03's "in-house tech OR external vendor" is an either/or the UI
/// should not have to fake with a radio button before showing the right
/// select.
export function AssignForm({
  action,
  staff,
  vendors,
}: {
  action: (state: WorkOrderFormState, formData: FormData) => Promise<WorkOrderFormState>
  staff: readonly { id: string; name: string }[]
  vendors: readonly { id: string; name: string }[]
}) {
  const [staffState, staffFormAction] = useActionState<WorkOrderFormState, FormData>(action, {})
  const [vendorState, vendorFormAction] = useActionState<WorkOrderFormState, FormData>(action, {})

  return (
    <div className="flex flex-col gap-6">
      {staff.length > 0 && (
        <form action={staffFormAction} className="flex max-w-xs flex-col gap-2">
          <FormAlerts state={staffState} />
          <SelectField
            label="Assign to staff"
            name="assignedStaffId"
            idPrefix="assign-staff"
            required
            options={staff.map((s) => ({ value: s.id, label: s.name }))}
          />
          <SubmitButton label="Assign to staff" />
        </form>
      )}

      {vendors.length > 0 && (
        <form action={vendorFormAction} className="flex max-w-xs flex-col gap-2">
          <FormAlerts state={vendorState} />
          <SelectField
            label="Assign to vendor"
            name="vendorId"
            idPrefix="assign-vendor"
            required
            options={vendors.map((v) => ({ value: v.id, label: v.name }))}
          />
          <SubmitButton label="Assign to vendor" />
        </form>
      )}
    </div>
  )
}
