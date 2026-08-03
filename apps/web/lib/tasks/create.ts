import 'server-only'

import type { TaskInput } from '@rental/core/tasks'
import { businessDateToUtc } from '@rental/core/scheduling'
import type { Prisma, PrismaClient, Task } from '@rental/db'

// The one place anything creates a Task (D-9) - the idempotent primitive the
// backlog names ("idempotent creation on (type, entityId, businessDate)").
// Every future producer (a delinquency step, a failed payment, a move-out
// verification, a bounced message) calls THIS rather than `prisma.task.create`
// directly, so none of them has to re-derive the claiming pattern below.

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Creates a task, or silently returns the one that already exists for the
 * same (type, subjectId, businessDate) - the schema's own unique index.
 *
 * Create-then-catch, not read-then-create: two producers racing to create
 * "rent 5 days late" for the same lease on the same day both reach here, the
 * unique index lets exactly one `create` through, and the loser's catch turns
 * the constraint violation into "here is the row that already exists" rather
 * than an error. Checking first would let both create - the same lesson
 * apps/web/lib/jobs/runner.ts's `runOne` already applies to JobRun.
 *
 * Callers pass a validated TaskInput; validation itself is NOT done here so a
 * caller inside a transaction can validate once, before opening it, the same
 * as every other write in this codebase.
 */
export async function createTask(
  db: Db,
  input: TaskInput,
): Promise<{ task: Task; created: boolean }> {
  try {
    const task = await db.task.create({
      data: {
        propertyId: input.propertyId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        businessDate: businessDateToUtc(input.businessDate),
        priority: input.priority as never,
        assigneeStaffId: input.assigneeStaffId,
        title: input.title,
      },
    })
    return { task, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const existing = await db.task.findUniqueOrThrow({
      where: {
        type_subjectId_businessDate: {
          type: input.type,
          subjectId: input.subjectId,
          businessDate: businessDateToUtc(input.businessDate),
        },
      },
    })
    return { task: existing, created: false }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  )
}
