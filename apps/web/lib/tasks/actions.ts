'use server'

import type { TaskPriorityValue } from '@rental/core/tasks'
import { randomUUID } from 'node:crypto'
import { businessDate } from '@rental/core/scheduling'
import {
  requiresAuditOnCompletion,
  type TaskInput,
  validateCompletion,
  validateTask,
} from '@rental/core/tasks'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireStaff } from '@/lib/auth/guard.ts'
import { completeTaskWork } from './complete.ts'
import { createTask } from './create.ts'

// Writes for the Task queue (D-9, R-011). Same shape as every other
// lib/*/actions.ts in this repo: a resource-carrying permission check first,
// then a transaction pairing the write with its audit entry where one is
// warranted.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function propertyOrThrow(propertyId: string) {
  return prisma.property.findUniqueOrThrow({ where: { id: propertyId } })
}

async function taskWithPropertyOrThrow(taskId: string) {
  return prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { property: true },
  })
}

/**
 * A staff-initiated, ad-hoc task with no domain event behind it - "check the
 * smoke detector batteries", "call the insurance broker". Deliberately NOT
 * idempotent: a human clicking "Add task" twice means two tasks, never a
 * silent no-op, so this mints a fresh `subjectId` per call rather than
 * routing through `createTask()`'s claim-or-return-existing semantics, which
 * exist for automated producers that might fire the same event twice.
 * `subjectType: "AdHoc"` marks that there is no real domain entity behind it.
 */
export async function addTask(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const propertyId = str(formData, 'propertyId')
  if (!propertyId) {
    return { error: 'Choose a property.' }
  }
  const property = await propertyOrThrow(propertyId)
  await requirePermission('task.write', propertyResource(property))

  const input: TaskInput = {
    propertyId,
    type: 'ad_hoc',
    subjectType: 'AdHoc',
    subjectId: randomUUID(),
    businessDate: businessDate(new Date(), property.timezone),
    // Cast at the FORM boundary, which is the one place a priority genuinely
    // arrives untyped - `validateTask` below is what actually rejects a value
    // that is not in TASK_PRIORITIES, and it runs before anything is written.
    // Everywhere else the enum is now carried as the enum (R-040e).
    priority: str(formData, 'priority') as TaskPriorityValue,
    title: str(formData, 'title'),
  }
  const violations = validateTask(input)
  if (violations.length > 0) return violationsToState(violations)

  const { task } = await createTask(prisma, input)

  revalidatePath('/tasks')
  redirect(`/tasks/${task.id}`)
}

/// Assigns the task to whoever calls this - the "anyone" half of "assignee
/// (nullable = anyone)". Refuses to steal a task someone else already
/// claimed; claiming one's own already-claimed task is a harmless no-op.
/// Two-argument useActionState calls this with (state, formData); declaring
/// neither here is fine - TypeScript allows a callback with fewer declared
/// parameters than the type it satisfies, and the form carries no fields.
export async function claimTask(taskId: string): Promise<FormState> {
  const actor = await requireStaff()
  const task = await taskWithPropertyOrThrow(taskId)
  await requirePermission('task.write', propertyResource(task.property))

  if (task.assigneeStaffId && task.assigneeStaffId !== actor.id) {
    return { error: 'Someone else already claimed this task.' }
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { assigneeStaffId: actor.id },
  })

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  return {}
}

export async function completeTask(
  taskId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireStaff()
  const task = await taskWithPropertyOrThrow(taskId)
  await requirePermission('task.write', propertyResource(task.property))

  if (task.status === 'DONE' || task.status === 'CANCELED') {
    return { error: 'This task is already resolved.' }
  }

  const note = str(formData, 'note')
  const proof = note ? { note } : null
  const violations = validateCompletion({ type: task.type, proof })
  if (violations.length > 0) return violationsToState(violations)

  await prisma.$transaction(async (tx) => completeTaskWork(tx, task, actor.id, proof))

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  redirect('/tasks')
}

/// Reuses `completedByStaffId`/`completedAt` for "resolved by/at" rather than
/// adding a second pair of columns for the cancel path - the schema has no
/// separate canceledBy/canceledAt, and a task is either done or it isn't
/// worth doing; who closed it out either way is the useful fact.
export async function cancelTask(taskId: string): Promise<FormState> {
  const actor = await requireStaff()
  const task = await taskWithPropertyOrThrow(taskId)
  await requirePermission('task.write', propertyResource(task.property))

  if (task.status === 'DONE' || task.status === 'CANCELED') {
    return { error: 'This task is already resolved.' }
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: taskId },
      data: { status: 'CANCELED', completedByStaffId: actor.id, completedAt: new Date() },
    })
    if (requiresAuditOnCompletion(task.type)) {
      await audit(
        {
          action: 'task.canceled',
          entityType: 'Task',
          entityId: taskId,
          propertyId: task.propertyId,
          before: { status: task.status },
          after: { status: updated.status },
        },
        tx,
      )
    }
  })

  revalidatePath('/tasks')
  revalidatePath(`/tasks/${taskId}`)
  redirect('/tasks')
}
