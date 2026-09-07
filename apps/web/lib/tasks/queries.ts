import 'server-only'

import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { priorityRank } from '@rental/core/tasks'
import { type Task, prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the Task queue (D-9, R-011). Scoped the same way R-009's unit
// queries and R-008's property list are: by `ResolvedScope.propertyIds`,
// which is already the RBAC scope intersected with whatever the property
// switcher currently has selected.

export const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED'] as const

export type TaskWithProperty = Task & { property: { id: string; name: string } }
export type TaskDetail = Task & {
  property: { id: string; name: string; legalEntityId: string }
  assignee: { id: string; name: string } | null
  completedBy: { id: string; name: string } | null
}

/**
 * "My day": everything due today or overdue, in scope, that is either
 * assigned to `staffId` or unclaimed (anyone's to pick up) - never a task
 * assigned to someone else.
 *
 * "Today" is evaluated per property, not globally: a portfolio spanning
 * timezones would otherwise show a Pacific property's tasks a few hours
 * early, or hide a Central property's overdue ones a few hours late, right
 * around the boundary (D-3, the same reasoning R-006's job runner applies).
 * With a 10-50 unit portfolio this is a handful of properties, each getting
 * one OR branch - not a query built for a row count this scale will never
 * see.
 */
export async function myDayTasks(
  scope: ResolvedScope,
  staffId: string,
  now: Date,
): Promise<TaskWithProperty[]> {
  if (scope.propertyIds.length === 0) return []

  const properties = await prisma.property.findMany({
    where: { id: { in: scope.propertyIds } },
    select: { id: true, timezone: true },
  })

  const tasks = await prisma.task.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      OR: [{ assigneeStaffId: staffId }, { assigneeStaffId: null }],
      AND: {
        OR: properties.map(({ id, timezone }) => ({
          propertyId: id,
          businessDate: { lte: businessDateToUtc(businessDate(now, timezone)) },
        })),
      },
    },
    include: { property: { select: { id: true, name: true } } },
  })

  return tasks.sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.businessDate.getTime() - b.businessDate.getTime(),
  )
}

export interface PropertyRollup {
  propertyId: string
  propertyName: string
  open: number
  overdue: number
  emergency: number
}

/// Portfolio roll-up: open/overdue/emergency counts per property, in scope.
export async function rollupByProperty(
  scope: ResolvedScope,
  now: Date,
): Promise<PropertyRollup[]> {
  if (scope.propertyIds.length === 0) return []

  const properties = await prisma.property.findMany({
    where: { id: { in: scope.propertyIds } },
    select: { id: true, name: true, timezone: true },
    orderBy: { name: 'asc' },
  })

  const tasks = await prisma.task.findMany({
    where: {
      propertyId: { in: properties.map((p) => p.id) },
      status: { in: [...OPEN_STATUSES] },
    },
    select: { propertyId: true, businessDate: true, priority: true },
  })

  return properties.map((property) => {
    const today = businessDateToUtc(businessDate(now, property.timezone))
    const mine = tasks.filter((t) => t.propertyId === property.id)
    return {
      propertyId: property.id,
      propertyName: property.name,
      open: mine.length,
      overdue: mine.filter((t) => t.businessDate < today).length,
      emergency: mine.filter((t) => t.priority === 'EMERGENCY').length,
    }
  })
}

/**
 * Every open task of one type, in scope, regardless of assignee or
 * businessDate (R-050). `myDayTasks()` deliberately excludes both a
 * future-dated task and anything assigned to someone else - right for "what
 * should I do today", wrong for a work-order approval, which is urgent to the
 * owner no matter who it is assigned to or when it was queued. Same
 * where-clause `pendingApprovalsSummary()` counts in lib/dashboard/queries.ts
 * - this is its list-returning sibling, for the dashboard tile's drill-down.
 *
 * R-173 made it take the type rather than hard-coding `workorder_approval`:
 * `serve_notice_offline` wants exactly the same query for exactly the same
 * reason. A notice nobody can be sent must not drop off the screen because it
 * is assigned to a colleague or was raised yesterday.
 */
export async function openTasksOfType(
  scope: ResolvedScope,
  type: string,
): Promise<TaskWithProperty[]> {
  if (scope.propertyIds.length === 0) return []

  const tasks = await prisma.task.findMany({
    where: openTasksWhere(scope, type),
    include: { property: { select: { id: true, name: true } } },
  })

  return tasks.sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.businessDate.getTime() - b.businessDate.getTime(),
  )
}

/**
 * The same queue, counted. For a screen that only needs to know whether there
 * is one - R-173's banner on the send log - where fetching every row in a
 * portfolio-wide scope to call `.length` on it would be the expensive way to
 * ask a yes/no question. Same where-clause, deliberately shared rather than
 * retyped: a filter that drifts between the count and the list is a badge
 * saying 3 over a page showing 5.
 */
export async function countOpenTasksOfType(
  scope: ResolvedScope,
  type: string,
): Promise<number> {
  if (scope.propertyIds.length === 0) return 0
  return prisma.task.count({ where: openTasksWhere(scope, type) })
}

function openTasksWhere(scope: ResolvedScope, type: string) {
  return {
    propertyId: { in: scope.propertyIds },
    type,
    status: { in: [...OPEN_STATUSES] },
  }
}

export async function getTask(
  taskId: string,
  scope: ResolvedScope,
): Promise<TaskDetail | null> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      property: { select: { id: true, name: true, legalEntityId: true } },
      assignee: { select: { id: true, name: true } },
      completedBy: { select: { id: true, name: true } },
    },
  })
  if (!task || !scope.propertyIds.includes(task.propertyId)) return null
  return task
}
