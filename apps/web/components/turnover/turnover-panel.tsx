'use client'

import { friendlyBusinessDate, friendlyDate } from '@rental/core/scheduling'
import {
  TURNOVER_STAGE_LABELS,
  TURNOVER_STAGES,
  type StagePlan,
  type TurnPlan,
} from '@rental/core/turnover'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField, SelectField, TextField } from '@/components/form/field.tsx'
import type { TurnoverFormState } from '@/lib/turnover/actions.ts'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

// The turnover / make-ready panel (LEASE-12, INSP-06, R-072). The punch
// list is not a bespoke list here - each row is an ordinary WorkOrder
// (see `TurnoverProject`'s own schema comment), so "add a stage" and every
// row's status/cost come straight from the maintenance machinery R-024
// already built.

// R-178: from core rather than a fourth hand-kept copy of the same list.
// This is a client component, and `stages.ts` is type-only-import-checked
// for exactly that reason (its own comment).
const STAGE_OPTIONS = TURNOVER_STAGES.map((value) => ({
  value,
  label: TURNOVER_STAGE_LABELS[value],
}))
const STAGE_LABELS: Record<string, string> = TURNOVER_STAGE_LABELS

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
  plan: TurnPlan
  items: TurnoverPunchListItemView[]
}

const STAGE_STATE_LABELS: Record<StagePlan['state'], string> = {
  EMPTY: 'No line',
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
}

/**
 * The sequence (R-178, review §10): each stage's own window laid forward
 * from the move-out, what it is waiting on, and what has run past its day.
 *
 * The turn's stall is what the nightly `cases.stalled` sweep raises as a
 * Task; this is the same facts on the screen somebody is already looking at,
 * so a PM can see the paint is what the floor guy is waiting on without
 * waiting six days for a queue to tell them.
 */
function TurnSchedule({ plan }: { plan: TurnPlan }) {
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <h3 id="turn-schedule" className="text-sm font-semibold">
        Turn schedule
      </h3>
      {/* NOT "Rent-ready ..." - that sentence already appears in this
          panel's own status line above, and `getByText` is a substring
          match, so a second copy would make the existing assertion on it
          ambiguous (CLAUDE.md's two-controls-one-name trap, arriving through
          prose rather than a control). */}
      <p className="text-muted-foreground text-sm">
        On these stage budgets the turn finishes{' '}
        {friendlyBusinessDate(plan.projectedRentReadyOn)}
        {plan.daysOverTarget != null && (
          <>
            {' '}
            — {plan.daysOverTarget} day{plan.daysOverTarget === 1 ? '' : 's'} past the target
            date
          </>
        )}
        .
      </p>
      <div
        className="overflow-x-auto"
        {...scrollableRegionProps('Turn schedule, scrolls sideways')}
      >
        <table className="w-full text-sm">
          <caption className="sr-only">
            Each turn stage with its planned window and what it is waiting on
          </caption>
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="py-1 pr-2 font-medium">Turn stage</th>
              <th className="py-1 pr-2 font-medium">Planned window</th>
              <th className="py-1 pr-2 font-medium">Stage status</th>
            </tr>
          </thead>
          <tbody>
            {plan.stages.map((stage) => (
              <tr key={stage.stage} className="border-t">
                <td className="py-1.5 pr-2">{stage.label}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  {friendlyBusinessDate(stage.startsOn)} – {friendlyBusinessDate(stage.dueOn)}
                </td>
                <td className="py-1.5 pr-2">
                  {STAGE_STATE_LABELS[stage.state]}
                  {stage.waitingOn && (
                    <> — waiting on {STAGE_LABELS[stage.waitingOn] ?? stage.waitingOn}</>
                  )}
                  {stage.overdue && (
                    <span className="text-destructive"> — past its day</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function TurnoverPanel({
  unitId,
  turnover,
  timeZone,
  canWrite,
  setTargetDateAction,
  markRentReadyAction,
  addItemAction,
}: {
  unitId: string
  turnover: TurnoverDetailView
  /// `rentReadyAt` is an instant and reads in the property's zone;
  /// `moveOutDate` is a calendar day and must not touch one.
  timeZone: string
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
        <dd>{friendlyBusinessDate(turnover.moveOutDate)}</dd>
        <dt className="text-muted-foreground">Days vacant</dt>
        <dd>
          {turnover.daysVacant} {turnover.daysVacantIsFinal ? '(final — tenant moved in)' : '(so far)'}
        </dd>
        <dt className="text-muted-foreground">Punch-list cost</dt>
        <dd>{formatCents(turnover.totalCostCents)}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          {turnover.rentReadyAt
            ? `Rent-ready ${friendlyDate(new Date(turnover.rentReadyAt), timeZone)}`
            : 'In progress'}
        </dd>
      </dl>

      <TurnSchedule plan={turnover.plan} />

      {turnover.items.length > 0 ? (
        <div className="overflow-x-auto" {...scrollableRegionProps('Turnover items, scrolls sideways')}>
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

          {/* The alerts live OUTSIDE the conditional below, which the action
              itself can turn off: marking the turn rent-ready revalidates
              this page, `rentReadyAt` stops being null, and a result region
              inside the form would unmount carrying its own success notice
              (CLAUDE.md's "a form's result region must not live inside a
              panel whose own render condition the action can change"). It is
              also what aria-live needs - a region that arrives with its text
              already in it announces nothing. */}
          <div className="flex flex-col gap-3 border-t pt-4">
            <FormAlerts state={rentReadyState} />
            {rentReadyState.warnings?.map((warning) => (
              <p
                key={warning}
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                {warning}
              </p>
            ))}
            {!turnover.rentReadyAt && (
              <form action={rentReadyFormAction} className="flex flex-col gap-3">
                {/* R-176. Shown only once the warning has fired, the same
                    shape the party-change panel uses: an override that is
                    always on screen is one nobody reads. */}
                {rentReadyState.warnings && rentReadyState.warnings.length > 0 && (
                  <CheckboxField
                    label="No re-key is recorded and I want to mark this rent-ready anyway"
                    name="acknowledgeNoRekey"
                  />
                )}
                <SubmitButton label="Mark rent-ready" />
              </form>
            )}
          </div>
        </>
      )}
    </section>
  )
}
