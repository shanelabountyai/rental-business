import { activeWarranties, likelyMatchingWarranty } from '@rental/core/workorders'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AssignForm } from '@/components/workorders/assign-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { assignWorkOrder, setWorkOrderWarrantyHold } from '@/lib/workorders/actions.ts'
import {
  activeVendors,
  getWorkOrder,
  staffForWorkOrderAssignment,
  warrantiesForProperty,
} from '@/lib/workorders/queries.ts'

export const metadata = { title: 'Work order — Rental Operations' }

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}
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
  ON_HOLD_WARRANTY: 'On hold — warranty claim',
  WAITING_ON_TENANT: 'Waiting on tenant',
  CANCELED: 'Canceled',
}

export default async function WorkOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('workorder.read')
  const scope = await currentScope(actor)

  const workOrder = await getWorkOrder(id, scope)
  if (!workOrder) notFound()

  const canWrite = await actorCan('workorder.write', propertyResource(workOrder.property))
  const canSeeVendors = await actorCan('vendor.read', propertyResource(workOrder.property))

  const [warranties, staff, vendors] = await Promise.all([
    warrantiesForProperty(workOrder.propertyId).then((w) => activeWarranties(w, new Date())),
    canWrite ? staffForWorkOrderAssignment(workOrder.propertyId) : Promise.resolve([]),
    canWrite && canSeeVendors ? activeVendors() : Promise.resolve([]),
  ])
  const likely = workOrder.ticket
    ? likelyMatchingWarranty(workOrder.ticket.category, warranties)
    : null

  const unassigned = !workOrder.assignedStaffId && !workOrder.vendorId
  const resolved = workOrder.status === 'CLOSED' || workOrder.status === 'CANCELED'
  const onHold = workOrder.status === 'ON_HOLD_WARRANTY'

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          <Link href="/workorders" className="underline underline-offset-4">
            {workOrder.property.name}
          </Link>
          {' — '}
          {workOrder.unit.name}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {workOrder.scope.slice(0, 80)}
        </h1>
      </header>

      {warranties.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p className="font-medium">Warranty status (PROP-06)</p>
          {warranties.map((w) => (
            <p
              key={w.id}
              className={w.id === likely?.id ? 'font-medium' : 'text-muted-foreground'}
            >
              {w.category} — {w.provider}
              {w.expiresOn && ` (expires ${w.expiresOn.toISOString().slice(0, 10)})`}
              {w.id === likely?.id && ' — likely covers this'}
            </p>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Priority</dt>
        <dd className="col-span-1 sm:col-span-2">
          {PRIORITY_LABELS[workOrder.priority] ?? workOrder.priority}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-1 sm:col-span-2">
          {STATUS_LABELS[workOrder.status] ?? workOrder.status}
          {workOrder.warrantyClaim && (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
              Warranty claim
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Estimate</dt>
        <dd className="col-span-1 sm:col-span-2">
          {workOrder.estimateCents != null
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                workOrder.estimateCents / 100,
              )
            : 'Not estimated'}
        </dd>
        <dt className="text-muted-foreground">Assigned to</dt>
        <dd className="col-span-1 sm:col-span-2">
          {workOrder.assignedTo?.name ?? workOrder.vendor?.name ?? 'Unassigned'}
        </dd>
        {workOrder.ticket && (
          <>
            <dt className="text-muted-foreground">From ticket</dt>
            <dd className="col-span-1 sm:col-span-2">
              <Link
                href={`/maintenance/${workOrder.ticket.id}`}
                className="underline underline-offset-4"
              >
                {workOrder.ticket.description.slice(0, 60)}
              </Link>
            </dd>
          </>
        )}
      </dl>

      {canWrite && !resolved && (
        <div className="flex flex-col gap-6 border-t pt-4">
          {unassigned && (staff.length > 0 || vendors.length > 0) && !onHold && (
            <AssignForm
              action={assignWorkOrder.bind(null, workOrder.id)}
              staff={staff}
              vendors={vendors}
            />
          )}
          {onHold ? (
            <TaskActionButton
              action={setWorkOrderWarrantyHold.bind(null, workOrder.id, false)}
              label="Resume from warranty hold"
            />
          ) : (
            <TaskActionButton
              action={setWorkOrderWarrantyHold.bind(null, workOrder.id, true)}
              label="Put on hold for warranty claim"
            />
          )}
        </div>
      )}
    </div>
  )
}
