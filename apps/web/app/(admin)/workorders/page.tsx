import Link from 'next/link'
import { requirePermission } from '@/lib/auth/guard.ts'
import { listOpenWorkOrders } from '@/lib/workorders/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Work orders — Rental Operations' }

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
  // Says what is WAITING, not what happened. A PM scanning this list needs to
  // know which rows are theirs to act on, and "Verified" reads as done.
  VERIFIED: 'Tenant confirmed — ready to close',
  ON_HOLD_WARRANTY: 'On hold — warranty claim',
  WAITING_ON_TENANT: 'Waiting on tenant',
  // Not in OPEN_STATUSES, so unreachable from this list today. Here so that a
  // status leak renders as a sentence rather than a raw enum.
  INVOICED: 'Invoiced',
  CLOSED: 'Closed',
  CANCELED: 'Canceled',
}

function friendlyDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(value)
}

/**
 * A bare, unsorted-by-priority list of everything open (MAINT-03) - the
 * same "R-022's own list before R-023 built the real queue on top" shape.
 * The in-house job list this item ALSO builds is the Task queue itself
 * (D-9, /tasks); this page is the PM's oversight view of every work order,
 * assigned or not, staff or vendor.
 */
export default async function WorkOrdersPage() {
  const actor = await requirePermission('workorder.read')
  const scope = await currentScope(actor)
  const workOrders = await listOpenWorkOrders(scope)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Work orders</h1>
        <Link
          href="/workorders/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          New work order
        </Link>
      </div>
      <p className="text-muted-foreground text-sm">
        {workOrders.length} open work order{workOrders.length === 1 ? '' : 's'} across{' '}
        {scope.propertyIds.length} propert{scope.propertyIds.length === 1 ? 'y' : 'ies'}.
      </p>

      {workOrders.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing open right now.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {workOrders.map((wo) => (
            <li key={wo.id}>
              <Link
                href={`/workorders/${wo.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {wo.scope.slice(0, 80)}
                  {wo.warrantyClaim && (
                    <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                      Warranty
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-sm">
                  {wo.property.name} — {wo.unit.name} ·{' '}
                  {PRIORITY_LABELS[wo.priority] ?? wo.priority} ·{' '}
                  {STATUS_LABELS[wo.status] ?? wo.status} ·{' '}
                  {wo.assignedTo?.name ?? wo.vendor?.name ?? 'Unassigned'} ·{' '}
                  {friendlyDate(wo.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
