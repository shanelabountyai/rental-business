// Work order creation and assignment (MAINT-03, R-024). Hand-rolled,
// matching every other packages/core validate.ts in this repo.
//
// WorkOrderStatus and Priority are TYPE-ONLY imports, checked against by
// `satisfies` - not a runtime import of the generated Prisma client. See
// packages/core/tasks/validate.ts's own comment for why: a value import
// here would be reachable from a client component and would drag the whole
// generated Prisma client into the browser bundle.

import type { Priority } from '@rental/db'
import { isTurnoverStage } from '../turnover/stages.ts'

interface Violation {
  field: string
  message: string
}

export const WORK_ORDER_PRIORITIES = [
  'EMERGENCY',
  'URGENT',
  'ROUTINE',
] as const satisfies readonly Priority[]
export type WorkOrderPriorityValue = (typeof WORK_ORDER_PRIORITIES)[number]

export interface WorkOrderInput {
  propertyId: string
  unitId: string
  /// Absent for a standalone work order (a make-ready turn, MAINT-03's own
  /// example) - not every work order starts from a ticket.
  ticketId?: string | null
  scope: string
  priority: string
  /// Whole cents, or null/undefined for "no estimate yet" - a PM creating a
  /// work order the moment a tech is standing in the unit often does not
  /// have one, and MAINT-03 does not make it required.
  estimateCents?: number | null
  entryPermission?: boolean
  petWarning?: boolean
  /// MAINT-03's own criterion: surfaced and decided at creation, not
  /// inferred later. See warranty.ts for how the create form suggests it.
  warrantyClaim?: boolean
  /// LEASE-12 (R-072): set together when this job is one line of a
  /// turnover's punch list. Absent for an ordinary maintenance work order.
  turnoverProjectId?: string | null
  turnoverStage?: string | null
}

export function validateWorkOrder(input: WorkOrderInput): Violation[] {
  const violations: Violation[] = []

  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A work order must belong to a property.' })
  }
  if (!input.unitId.trim()) {
    violations.push({ field: 'unitId', message: 'Choose a unit.' })
  }
  if (!input.scope.trim()) {
    violations.push({ field: 'scope', message: 'Describe the scope of work.' })
  }
  if (!(WORK_ORDER_PRIORITIES as readonly string[]).includes(input.priority)) {
    violations.push({ field: 'priority', message: 'Choose a priority.' })
  }
  if (
    input.estimateCents != null &&
    (!Number.isInteger(input.estimateCents) || input.estimateCents < 0)
  ) {
    violations.push({ field: 'estimateCents', message: 'Enter a whole-dollar amount of $0 or more.' })
  }
  if (input.turnoverStage != null && !isTurnoverStage(input.turnoverStage)) {
    violations.push({ field: 'turnoverStage', message: 'Choose a valid checklist stage.' })
  }

  return violations
}

export interface AssignmentInput {
  assignedStaffId?: string | null
  vendorId?: string | null
}

/// Exactly one of staff or vendor - "assign to in-house tech or external
/// vendor" (MAINT-03) is an either/or, and a work order pointing at both
/// would leave two people showing up not knowing about each other.
export function validateAssignment(input: AssignmentInput): Violation[] {
  const hasStaff = Boolean(input.assignedStaffId)
  const hasVendor = Boolean(input.vendorId)

  if (hasStaff === hasVendor) {
    return [
      {
        field: 'assignee',
        message: hasStaff
          ? 'Assign to either a staff member or a vendor, not both.'
          : 'Choose a staff member or a vendor to assign this to.',
      },
    ]
  }
  return []
}
