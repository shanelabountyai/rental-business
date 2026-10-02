import { businessDate, businessDaysBetween, friendlyDate } from '@rental/core/scheduling'
import { priorityRank } from '@rental/core/tasks'
import { WORK_ORDER_STATUS_LABELS } from '@rental/core/workorders'
import Link from 'next/link'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { listOpenWorkOrders } from '@/lib/workorders/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { PageHeader } from '@/components/page-header.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { Badge, type BadgeTone } from '@/components/badge.tsx'

export const metadata = { title: 'Work orders — Rental Operations' }

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}

const PRIORITY_BADGE_TONE: Record<string, BadgeTone> = {
  EMERGENCY: 'danger',
  URGENT: 'warning',
}

function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={PRIORITY_BADGE_TONE[priority] ?? 'neutral'}>{PRIORITY_LABELS[priority] ?? priority}</Badge>
}

function StatusBadge({ status }: { status: string }) {
  return <Badge>{WORK_ORDER_STATUS_LABELS[status] ?? status}</Badge>
}
/**
 * The PM's oversight view of every open work order, assigned or not, staff
 * or vendor (MAINT-03) - and RPT-04's own "open work orders by age and
 * priority" weekly report, once sorted that way (R-076; this page was
 * "bare, unsorted" until this item, per its own prior comment). Worst
 * priority first, oldest within a priority first - the same ordering a PM
 * triaging a Monday-morning list actually wants, EMERGENCY items that have
 * sat the longest at the very top.
 *
 * The in-house job list this item ALSO builds is the Task queue itself
 * (D-9, /tasks); this page is the oversight view, not the work queue.
 */
function ageInDays(createdAt: Date, timezone: string): number {
  return businessDaysBetween(businessDate(createdAt, timezone), businessDate(new Date(), timezone))
}

export default async function WorkOrdersPage() {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('workorder.read')
  const scope = await currentScope(actor, 'workorder.read')
  const unsorted = await listOpenWorkOrders(scope)
  const workOrders = [...unsorted].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.createdAt.getTime() - b.createdAt.getTime(),
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <PageHeader title="Work orders" />
        <Link
          href="/workorders/new"
          className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 items-center justify-center px-4 text-sm`}
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
                className="hover:bg-secondary focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-1 rounded-md border px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {wo.scope.slice(0, 80)}
                  {wo.warrantyClaim && (
                    <span className="ml-2">
                      <Badge tone="info">Warranty</Badge>
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
                  {wo.property.name} — {wo.unit.name}
                  <PriorityBadge priority={wo.priority} />
                  <StatusBadge status={wo.status} />
                  <span>
                    · {wo.assignedTo?.name ?? wo.vendor?.name ?? 'Unassigned'} ·{' '}
                    {friendlyDate(wo.createdAt, wo.property.timezone)} (
                    {ageInDays(wo.createdAt, wo.property.timezone)}d)
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
