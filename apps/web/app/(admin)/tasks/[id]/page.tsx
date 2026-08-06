import {
  CATEGORY_LABELS,
  firstResponseSlaState,
  isTicketTriageResolved,
} from '@rental/core/maintenance'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { CompleteForm } from '@/components/tasks/complete-form.tsx'
import { TriagePanel } from '@/components/maintenance/triage-panel.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import {
  mergeTicketDuplicate,
  resolveTicketTriage,
  setTicketPriority,
} from '@/lib/maintenance/actions.ts'
import { getStaffTicket, listOpenTickets } from '@/lib/maintenance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { cancelTask, claimTask, completeTask } from '@/lib/tasks/actions.ts'
import { getTask } from '@/lib/tasks/queries.ts'

export const metadata = { title: 'Task — Rental Operations' }

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}
const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  CANCELED: 'Canceled',
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('task.read')
  const scope = await currentScope(actor)

  const task = await getTask(id, scope)
  if (!task) notFound()

  const canWrite = await actorCan('task.write', propertyResource(task.property))
  const canTriage = await actorCan('ticket.write', propertyResource(task.property))
  // task.read alone does not imply ticket.read - every role in this build
  // happens to grant both together today, but that is this role table's
  // current shape, not a guarantee this page may lean on (ROLE-01's own
  // "hide, don't just block" - a task-only role added later must not leak a
  // tenant's ticket description through the one page every task shares).
  const canReadTicket = await actorCan('ticket.read', propertyResource(task.property))
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: task.property.id },
    select: { timezone: true },
  })
  const overdue =
    task.businessDate < businessDateToUtc(businessDate(new Date(), property.timezone))
  const unresolved = task.status !== 'DONE' && task.status !== 'CANCELED'
  const claimable = unresolved && !task.assigneeStaffId

  // R-023: a ticket-triage task's own detail carries the ticket's fields and
  // actions alongside the generic Task ones above - not instead of them,
  // since claiming and canceling still mean the same thing they always did.
  const ticket =
    task.subjectType === 'Ticket' && canReadTicket
      ? await getStaffTicket(task.subjectId, scope)
      : null
  const mergeCandidates = ticket
    ? (await listOpenTickets(scope))
        .filter((t) => t.id !== ticket.id && t.propertyId === ticket.propertyId)
        .map((t) => ({
          id: t.id,
          label: `${CATEGORY_LABELS[t.category as keyof typeof CATEGORY_LABELS] ?? 'Uncategorized'} — ${t.unit.name}`,
        }))
    : []

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          <Link href="/tasks" className="underline underline-offset-4">
            {task.property.name}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{task.title}</h1>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Priority</dt>
        <dd className="col-span-1 sm:col-span-2">
          {PRIORITY_LABELS[task.priority] ?? task.priority}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-1 sm:col-span-2">
          {STATUS_LABELS[task.status] ?? task.status}
          {unresolved && overdue && (
            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
              Overdue
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Due</dt>
        <dd className="col-span-1 sm:col-span-2">
          {task.businessDate.toISOString().slice(0, 10)}
        </dd>
        <dt className="text-muted-foreground">Assigned to</dt>
        <dd className="col-span-1 sm:col-span-2">
          {task.assignee?.name ?? 'Unclaimed - anyone may pick this up'}
        </dd>
        {!unresolved && (
          <>
            <dt className="text-muted-foreground">
              {task.status === 'DONE' ? 'Completed by' : 'Canceled by'}
            </dt>
            <dd className="col-span-1 sm:col-span-2">
              {task.completedBy?.name ?? '—'}
              {task.completedAt && ` on ${task.completedAt.toISOString().slice(0, 10)}`}
            </dd>
          </>
        )}
        {task.proof != null && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd className="col-span-1 sm:col-span-2">
              {(task.proof as { note?: string }).note ?? '—'}
            </dd>
          </>
        )}
      </dl>

      {ticket && (
        <TriagePanel
          ticket={{
            category: ticket.category,
            categoryLabel:
              CATEGORY_LABELS[ticket.category as keyof typeof CATEGORY_LABELS] ??
              'Uncategorized',
            description: ticket.description,
            source: ticket.source,
            priority: ticket.priority,
            status: ticket.status,
            habitabilityFlag: ticket.habitabilityFlag,
            mergedIntoTicketId: ticket.mergedIntoTicketId,
          }}
          slaState={firstResponseSlaState(ticket, new Date())}
          mergeCandidates={mergeCandidates}
          setPriorityAction={setTicketPriority.bind(null, task.id)}
          mergeAction={mergeTicketDuplicate.bind(null, task.id)}
          resolveAction={resolveTicketTriage.bind(null, task.id)}
          resolved={isTicketTriageResolved(ticket.status)}
          canWrite={canTriage}
        />
      )}

      {canWrite && unresolved && (
        <div className="flex flex-col gap-4 border-t pt-4">
          {claimable && (
            <TaskActionButton action={claimTask.bind(null, task.id)} label="Claim this task" />
          )}
          {!ticket && <CompleteForm action={completeTask.bind(null, task.id)} />}
          <TaskActionButton action={cancelTask.bind(null, task.id)} label="Cancel task" />
        </div>
      )}
    </div>
  )
}
