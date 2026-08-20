'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { TurnoverFormState } from '@/lib/turnover/actions.ts'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

// The turnover / make-ready panel (LEASE-12, INSP-06, R-072). The punch
// list is not a bespoke list here - each row is an ordinary WorkOrder
// (see `TurnoverProject`'s own schema comment), so "add a stage" and every
// row's status/cost come straight from the maintenance machinery R-024
// already built.

const STAGE_OPTIONS = [
  { value: 'TRASH_OUT', label: 'Trash-out' },
  { value: 'REPAIRS', label: 'Repairs' },
  { value: 'PAINT', label: 'Paint' },
  { value: 'FLOORS', label: 'Floors' },
  { value: 'CLEAN', label: 'Clean' },
  { value: 'REKEY', label: 'Re-key' },
  { value: 'OTHER', label: 'Other' },
]

const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  STAGE_OPTIONS.map((o) => [o.value, o.label]),
)

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted',
  TRIAGED: 'Triaged',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  ASSIGNED: 'Assigned',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  WORK_COMPLETE: 'Work complete',
  VERIFIED: 'Verified',
  INVOICED: 'Invoiced',
  CLOSED: 'Closed',
  ON_HOLD_WARRANTY: 'On hold (warranty)',
  WAITING_ON_TENANT: 'Waiting on tenant',
  CANCELED: 'Canceled',
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export interface TurnoverPunchListItemView {
  id: string
  scope: string
  stage: string | null
  status: string
  priority: string
  vendorName: string | null
  assignedStaffName: string | null
  costCents: number
}

export interface TurnoverDetailView {
  id: string
  targetRentReadyDate: string | null
  rentReadyAt: string | null
  moveOutDate: string
  daysVacant: number
  daysVacantIsFinal: boolean
  totalCostCents: number
  items: TurnoverPunchListItemView[]
}

export function TurnoverPanel({
  unitId,
  turnover,
  canWrite,
  setTargetDateAction,
  markRentReadyAction,
  addItemAction,
}: {
  unitId: string
  turnover: TurnoverDetailView
  canWrite: boolean
  setTargetDateAction: (state: TurnoverFormState, formData: FormData) => Promise<TurnoverFormState>
  markRentReadyAction: (state: TurnoverFormState, formData: FormData) => Promise<TurnoverFormState>
  addItemAction: (state: WorkOrderFormState, formData: FormData) => Promise<WorkOrderFormState>
}) {
  const [targetState, targetFormAction] = useActionState<TurnoverFormState, FormData>(
    setTargetDateAction,
    {},
  )
  const [rentReadyState, rentReadyFormAction] = useActionState<TurnoverFormState, FormData>(
    markRentReadyAction,
    {},
  )
  const [itemState, itemFormAction] = useActionState<WorkOrderFormState, FormData>(addItemAction, {})
  const itemErrors = itemState.fieldErrors ?? {}

  return (
    <section aria-labelledby="turnover" className="flex flex-col gap-4 rounded-md border p-4">
      <h2 id="turnover" className="text-sm font-semibold">
        Turnover
      </h2>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Move-out</dt>
        <dd>{turnover.moveOutDate}</dd>
        <dt className="text-muted-foreground">Days vacant</dt>
        <dd>
          {turnover.daysVacant} {turnover.daysVacantIsFinal ? '(final — tenant moved in)' : '(so far)'}
        </dd>
        <dt className="text-muted-foreground">Punch-list cost</dt>
        <dd>{formatCents(turnover.totalCostCents)}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          {turnover.rentReadyAt
            ? `Rent-ready ${new Date(turnover.rentReadyAt).toISOString().slice(0, 10)}`
            : 'In progress'}
        </dd>
      </dl>

      {turnover.items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="py-1 pr-2 font-medium">Scope</th>
                <th className="py-1 pr-2 font-medium">Stage</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 pr-2 font-medium">Assigned</th>
                <th className="py-1 pr-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {turnover.items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="py-1.5 pr-2">
                    <a href={`/workorders/${item.id}`} className="underline underline-offset-2">
                      {item.scope}
                    </a>
                  </td>
                  <td className="py-1.5 pr-2">{item.stage ? STAGE_LABELS[item.stage] : '—'}</td>
                  <td className="py-1.5 pr-2">{STATUS_LABELS[item.status] ?? item.status}</td>
                  <td className="py-1.5 pr-2">{item.vendorName ?? item.assignedStaffName ?? '—'}</td>
                  <td className="py-1.5 pr-2">{formatCents(item.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No punch-list items yet.</p>
      )}

      {canWrite && (
        <>
          <form action={itemFormAction} className="flex flex-col gap-3 border-t pt-4">
            <input type="hidden" name="unitId" value={unitId} />
            <input type="hidden" name="turnoverProjectId" value={turnover.id} />
            <input type="hidden" name="priority" value="ROUTINE" />
            <FormAlerts state={itemState} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <TextField
                  label="Add checklist item"
                  name="scope"
                  required
                  idPrefix="turnover-item"
                  error={itemErrors.scope}
                />
              </div>
              <SelectField
                label="Stage"
                name="turnoverStage"
                idPrefix="turnover-item"
                placeholder="Unassigned"
                options={STAGE_OPTIONS}
                error={itemErrors.turnoverStage}
              />
            </div>
            <SubmitButton label="Add" />
          </form>

          <form action={targetFormAction} className="flex items-end gap-3 border-t pt-4">
            <FormAlerts state={targetState} />
            <TextField
              label="Target rent-ready date"
              name="targetRentReadyDate"
              type="date"
              idPrefix="turnover-target"
              defaultValue={turnover.targetRentReadyDate ?? undefined}
            />
            <SubmitButton label="Save" />
          </form>

          {!turnover.rentReadyAt && (
            <form action={rentReadyFormAction} className="border-t pt-4">
              <FormAlerts state={rentReadyState} />
              <SubmitButton label="Mark rent-ready" />
            </form>
          )}
        </>
      )}
    </section>
  )
}
