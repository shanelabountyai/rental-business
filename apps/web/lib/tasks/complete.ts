import 'server-only'

import { requiresAuditOnCompletion } from '@rental/core/tasks'
import type { Prisma, PrismaClient, Task } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'

// The one place a Task actually gets marked DONE (D-9's "one Task entity"
// carried one step further: one completion primitive, not one per caller).
//
// tasks/actions.ts's own completeTask() is the generic staff-facing form.
// R-023 resolves a ticket-triage task from its own domain-specific action
// (marking it waiting-on-tenant, converted, merged or closed IS the
// completion, not a separate step a PM has to remember to also click) and
// needs the identical write - so this is that write, extracted rather than
// duplicated. A second copy of "mark done, stamp who and when, audit if the
// type demands it" is exactly how the two would eventually disagree about
// what completing a task means.

type Db = PrismaClient | Prisma.TransactionClient

export async function completeTaskWork(
  tx: Db,
  task: { id: string; type: string; status: string; propertyId: string },
  actorId: string,
  proof: Prisma.InputJsonValue | null,
): Promise<Task> {
  const updated = await tx.task.update({
    where: { id: task.id },
    data: {
      status: 'DONE',
      completedByStaffId: actorId,
      completedAt: new Date(),
      proof: proof ?? undefined,
    },
  })
  if (requiresAuditOnCompletion(task.type)) {
    await audit(
      {
        action: 'task.completed',
        entityType: 'Task',
        entityId: task.id,
        propertyId: task.propertyId,
        before: { status: task.status },
        after: { status: updated.status, proof },
      },
      tx,
    )
  }
  return updated
}
