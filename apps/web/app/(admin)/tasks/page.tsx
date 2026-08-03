import { scopeIsEmpty } from '@rental/core/rbac'
import Link from 'next/link'
import { currentScope as writeScope, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { myDayTasks, rollupByProperty } from '@/lib/tasks/queries.ts'

export const metadata = { title: 'Tasks — Rental Operations' }

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}

// The one work queue (D-9): every staff queue in the product is a view over
// this. requireScope, not a bare requirePermission('task.read') - the same
// dormant scoping bug R-008 found on other list pages would otherwise deny
// an entity- or property-scoped tech a "my day" list that should show them
// their own real, non-empty queue (see requireScope's own comment).
export default async function TasksPage() {
  const { actor } = await requireScope('task.read')
  const scope = await currentScope(actor)
  const now = new Date()

  const [tasks, rollup, taskWriteScope] = await Promise.all([
    myDayTasks(scope, actor.id, now),
    rollupByProperty(scope, now),
    writeScope('task.write'),
  ])
  const canWrite = !scopeIsEmpty(taskWriteScope)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My day</h1>
          <p className="text-muted-foreground text-sm">
            {tasks.length} task{tasks.length === 1 ? '' : 's'} due today or
            overdue, in {scope.propertyIds.length} propert
            {scope.propertyIds.length === 1 ? 'y' : 'ies'}.
          </p>
        </div>
        {canWrite && (
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
          Nothing due today or overdue. Nice.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                href={`/tasks/${task.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-11 flex-col gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="font-medium">
                  {task.priority === 'EMERGENCY' && (
                    <span className="mr-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
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
            role="region"
            aria-label="Portfolio roll-up"
            tabIndex={0}
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
