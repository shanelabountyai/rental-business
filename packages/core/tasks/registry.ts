// Which task TYPES need something extra at completion time. Both registries
// are closed sets in code, matching packages/core/rbac/permissions.ts's
// PRIVILEGED_PERMISSIONS and packages/core/audit/events.ts's REASON_REQUIRED -
// "a flag no check ever reads is a promise the product does not keep."
//
// Both start EMPTY. R-011 builds the queue before its first consumer (D-9,
// the backlog's own framing) - there is no real task type yet to require
// proof of, or to audit. Future items register their own type here the
// moment they introduce it: a meter-reading task needs PROOF_REQUIRED, a
// deposit-disposition or compliance task needs AUDITED. Nothing does yet, so
// today every completion is unconditional and un-audited beyond the Task
// row's own completedByStaffId/completedAt - which is itself a permanent
// record, just not one that shows up in `auditTrailFor()`.

export const PROOF_REQUIRED_TASK_TYPES: ReadonlySet<string> = new Set()

export function requiresProof(
  type: string,
  registry: ReadonlySet<string> = PROOF_REQUIRED_TASK_TYPES,
): boolean {
  return registry.has(type)
}

/// A ticket-triage decision (R-023) is exactly RISK-05's "response-time
/// logging" - completing this task type IS the auditable event.
export const AUDITED_TASK_TYPES: ReadonlySet<string> = new Set(['ticket_triage'])

export function requiresAuditOnCompletion(
  type: string,
  registry: ReadonlySet<string> = AUDITED_TASK_TYPES,
): boolean {
  return registry.has(type)
}

export interface TaskCompletionInput {
  type: string
  proof: Record<string, unknown> | null
}

/// Not exported: same shape as every other module's local Violation. See
/// packages/core/units/validate.ts for why this is never re-exported.
interface Violation {
  field: string
  message: string
}

export function validateCompletion(
  input: TaskCompletionInput,
  registry: ReadonlySet<string> = PROOF_REQUIRED_TASK_TYPES,
): Violation[] {
  if (
    requiresProof(input.type, registry) &&
    (!input.proof || Object.keys(input.proof).length === 0)
  ) {
    return [
      {
        field: 'proof',
        message: 'This task type requires proof of completion before it can be marked done.',
      },
    ]
  }
  return []
}
