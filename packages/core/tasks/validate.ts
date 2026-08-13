import type { Priority, TaskStatus } from '@rental/db'
import { businessDateToUtc } from '../scheduling/local-time.ts'

// Validation for the one Task queue (D-9, R-011). Hand-rolled, matching every
// other packages/core validate.ts in this repo.
//
// TaskStatus and Priority are TYPE-ONLY imports, checked against by
// `satisfies` - not a runtime import of the generated Prisma enum. See
// packages/core/jurisdiction/validate.ts's own comment: a value import here
// would be reachable from apps/web/components/tasks/*.tsx client components
// and would drag the whole generated Prisma client into the browser bundle.

interface Violation {
  field: string
  message: string
}

export const TASK_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'CANCELED',
] as const satisfies readonly TaskStatus[]
export type TaskStatusValue = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = [
  'EMERGENCY',
  'URGENT',
  'ROUTINE',
] as const satisfies readonly Priority[]
export type TaskPriorityValue = (typeof TASK_PRIORITIES)[number]

const PRIORITY_RANK: Record<string, number> = {
  EMERGENCY: 0,
  URGENT: 1,
  ROUTINE: 2,
}

/// Lower sorts first. An unrecognised priority sorts last rather than
/// throwing - a "my day" list should still render around a bad row, not 500.
export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority] ?? 99
}

export interface TaskInput {
  propertyId: string
  /// Free-form (no closed vocabulary): a later item can introduce a new task
  /// type without a migration or a core code change, per the schema's own
  /// comment. Whatever creates a task also writes its own `title`, since only
  /// the producer knows how to phrase it for a human.
  type: string
  subjectType: string
  subjectId: string
  /// A property-local calendar day, `YYYY-MM-DD` (D-3).
  businessDate: string
  /// The enum, not a string (R-040e). It was `string` with the persistence
  /// layer casting it away as `never`, so an invalid priority typechecked
  /// cleanly and failed at runtime inside Prisma - twice, on two different
  /// items, both times spelling a value this product does not have. The
  /// validator below still checks it, because a value arriving from a form is
  /// not typed; the type stops the ones written in code.
  priority: TaskPriorityValue
  assigneeStaffId?: string | null
  title: string
}

export function validateTask(input: TaskInput): Violation[] {
  const violations: Violation[] = []

  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A task must belong to a property.' })
  }
  if (!input.type.trim()) {
    violations.push({ field: 'type', message: 'Give the task a type.' })
  }
  if (!input.subjectType.trim()) {
    violations.push({ field: 'subjectType', message: 'What is this task about?' })
  }
  if (!input.subjectId.trim()) {
    violations.push({ field: 'subjectId', message: 'What is this task about?' })
  }
  if (!input.title.trim()) {
    violations.push({ field: 'title', message: 'Give the task a short title.' })
  }
  if (!(TASK_PRIORITIES as readonly string[]).includes(input.priority)) {
    violations.push({ field: 'priority', message: 'Choose a priority.' })
  }

  try {
    businessDateToUtc(input.businessDate)
  } catch {
    violations.push({ field: 'businessDate', message: 'Enter a valid date.' })
  }

  return violations
}
