'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { DepositFormState } from '@/lib/deposits/actions.ts'

export function AddDeductionForm({
  action,
  workOrders,
  inspectionItems,
}: {
  action: (state: DepositFormState, formData: FormData) => Promise<DepositFormState>
  workOrders: readonly { id: string; label: string }[]
  inspectionItems: readonly { id: string; label: string }[]
}) {
  const [state, formAction] = useActionState<DepositFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} encType="multipart/form-data" className="flex flex-col gap-4">
      <FormAlerts state={state} />
      <TextField
        label="Description"
        name="description"
        required
        error={errors.description}
      />
      <TextField
        label="Amount ($)"
        name="amountDollars"
        type="number"
        inputMode="decimal"
        min={0}
        step={0.01}
        required
        error={errors.amountDollars}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Backed by a work order (optional)"
          name="workOrderId"
          idPrefix="deduction"
          placeholder="None"
          options={workOrders.map((wo) => ({ value: wo.id, label: wo.label }))}
        />
        <SelectField
          label="Backed by a move-out photo (optional)"
          name="inspectionItemId"
          idPrefix="deduction"
          placeholder="None"
          options={inspectionItems.map((item) => ({ value: item.id, label: item.label }))}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Estimated age (years, optional)"
          name="estimatedAgeYears"
          type="number"
          inputMode="numeric"
          min={0}
          error={errors.estimatedAgeYears}
        />
        <TextField
          label="Useful life (years, optional)"
          name="usefulLifeYears"
          type="number"
          inputMode="numeric"
          min={0}
          error={errors.usefulLifeYears}
          hint="Full replacement cost on an item past its useful life rarely holds up - fill both in for a depreciation check."
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="deduction-file" className="text-sm font-medium">
          Invoice or receipt (optional)
        </label>
        <input id="deduction-file" type="file" name="file" className="text-sm" />
      </div>
      <SubmitButton label="Add deduction" />
    </form>
  )
}
