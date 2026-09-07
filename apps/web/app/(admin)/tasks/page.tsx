import { scopeIsEmpty } from '@rental/core/rbac'
import Link from 'next/link'
import { currentScope as writeScope, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { myDayTasks, openTasksOfType, rollupByProperty } from '@/lib/tasks/queries.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'Tasks — Rental Operations' }

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}

/**
 * The drill-down views: one task type, every open row in scope, whoever it is
 * assigned to and whenever it was raised (`openTasksOfType`).
 *
 * `serve_notice_offline` is R-173's "cannot be reached electronically" queue.
 * It is a view over the one Task table (D-9) rather than a second queue, and
 * it is a view rather than a page of its own because "my day" is the wrong
 * lens for it: a notice we could not deliver is not less owed because it was
 * raised on Tuesday and belongs to a colleague.
 */
const DRILL_DOWNS: Record<
  string,
  { heading: string; blurb: (count: number) => string; empty: string }
> = {
  workorder_approval: {
    heading: 'Pending approvals',
    blurb: (count) =>
      `${count} work order${count === 1 ? '' : 's'} waiting on a decision.`,
    empty: 'Nothing waiting on approval.',
  },
  serve_notice_offline: {
    heading: 'Cannot be reached electronically',
    blurb: (count) =>
      `${count} notice${count === 1 ? '' : 's'} that has to be served on paper. Open one, print it, and record the service on the notice itself.`,
    empty: 'Everybody we owe a notice can be reached electronically.',
  },
}

// The one work queue (D-9): every staff queue in the product is a view over
// this. requireScope, not a bare requirePermission('task.read') - the same
// dormant scoping bug R-008 found on other list pages would otherwise deny
// an entity- or property-scoped tech a "my day" list that should show them
// their own real, non-empty queue (see requireScope's own comment).
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  const { actor } = await requireScope('task.read')
  const scope = await currentScope(actor)
  const now = new Date()
  const { type } = await searchParams
  // R-050's dashboard drills the "pending approvals" tile in here rather
  // than to `myDayTasks` - an approval is urgent to the owner regardless of
  // assignee or businessDate, which is exactly what that query excludes.
  // See `openTasksOfType`'s own comment. R-173's offline-service queue is
  // the second view through the same door.
  const drillDown = type != null ? DRILL_DOWNS[type] : undefined

  const [tasks, rollup, taskWriteScope] = await Promise.all([
    drillDown ? openTasksOfType(scope, type!) : myDayTasks(scope, actor.id, now),
    drillDown ? Promise.resolve([]) : rollupByProperty(scope, now),
    writeScope('task.write'),
  ])
  const canWrite = !scopeIsEmpty(taskWriteScope)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {drillDown ? drillDown.heading : 'My day'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {drillDown ? (
              <>
                {drillDown.blurb(tasks.length)}{' '}
                <Link href="/tasks" className="underline underline-offset-2">
                  Back to my day
                </Link>
              </>
            ) : (
              <>
                {tasks.length} task{tasks.length === 1 ? '' : 's'} due today or
                overdue, in {scope.propertyIds.length} propert
                {scope.propertyIds.length === 1 ? 'y' : 'ies'}.
              </>
            )}
          </p>
        </div>
        {canWrite && !drillDown && (
          <Link
            href="/tasks/new"
            className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Add task
          </Link>
        )}
      </header>

      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {drillDown ? drillDown.empty : 'Nothing due today or overdue. Nice.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                href={`/tasks/${task.id}`}
                className="hover:bg-secondary focus-visible:ring-ring flex min-h-11 flex-col gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="font-medium">
                  {task.priority === 'EMERGENCY' && (
                    <span className="mr-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                      {PRIORITY_LABELS.EMERGENCY}
                    </span>
                  )}
                  {task.title}
                </span>
                <span className="text-muted-foreground text-sm">
                  {task.property.name}
                  {task.assigneeStaffId == null && ' · Unclaimed'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {rollup.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Portfolio roll-up
          </h2>
          <div
            className="overflow-x-auto rounded-md border"
            {...scrollableRegionProps('Portfolio roll-up')}
          >
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Property
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Open
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Overdue
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Emergency
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rollup.map((row) => (
                  <tr key={row.propertyId}>
                    <td className="px-4 py-2">{row.propertyName}</td>
                    <td className="px-4 py-2">{row.open}</td>
                    <td className="px-4 py-2">{row.overdue}</td>
                    <td className="px-4 py-2">{row.emergency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!canWrite && (
        <p className="text-muted-foreground text-xs">
          You can work tasks in your scope but not add new ones.
        </p>
      )}
    </div>
  )
}
