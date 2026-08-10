import 'server-only'

import { type InheritedGap, inheritedGaps } from '@rental/core/leases'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { hasConditionBaseline } from './queries.ts'

// The inherited-tenancy onboarding workflow (RISK-08, R-033).
//
// D-9, applied: the outstanding items are `Task` rows in the one queue every
// other kind of staff work already lives in. There is deliberately no
// "acquisition checklist" table - a second queue is exactly what D-9 forbids,
// and a PM should find "confirm the terms with Grant Okafor" in the same
// place they find "triage this ticket", not on a separate screen they have
// to remember exists.

/// Task types raised by the intake. Free-form strings, per the Task schema's
/// own comment - named here so the raiser and any later reader cannot
/// disagree about spelling.
const TASK_TYPE: Record<InheritedGap, string> = {
  estoppel: 'lease_estoppel_confirmation',
  deposit_transfer: 'lease_deposit_transfer',
  condition_baseline: 'lease_condition_baseline',
}

/// Phrased as the thing a person does, not the field that is null.
/// "Confirm the terms with the tenant" is a task; "estoppelConfirmedAt is
/// null" is a schema complaint.
const TASK_TITLE: Record<InheritedGap, (who: string, where: string) => string> = {
  estoppel: (who, where) => `Confirm the inherited lease terms with ${who} (${where})`,
  deposit_transfer: (_who, where) =>
    `Establish whether the deposit transferred at closing (${where})`,
  condition_baseline: (_who, where) =>
    `Capture condition-as-found photos before anything changes (${where})`,
}

export interface IntakeSweepResult {
  raised: number
  gaps: InheritedGap[]
}

/**
 * Raises a Task for each outstanding item on an inherited tenancy.
 *
 * Idempotent through `createTask()`'s own key of (type, subjectId,
 * businessDate) - calling this twice in a day raises nothing the second
 * time, and calling it again tomorrow raises a fresh prompt for whatever is
 * still outstanding. That cadence is deliberate: these are things that get
 * harder to establish every week, so a daily nudge is the right pressure,
 * and going silent after one ask is how an unquantified deposit liability
 * survives to move-out.
 *
 * URGENT, not routine. The window in which a seller still answers the phone
 * and the paint still looks how it looked at closing is measured in weeks.
 */
export async function raiseIntakeTasks(
  leaseId: string,
  now = new Date(),
): Promise<IntakeSweepResult> {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      origin: true,
      estoppelConfirmedAt: true,
      depositTransferStatus: true,
      property: { select: { name: true, timezone: true } },
      unit: { select: { name: true } },
      leaseTenants: {
        where: { isPrimary: true },
        take: 1,
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
    },
  })
  if (!lease) return { raised: 0, gaps: [] }

  const gaps = inheritedGaps({
    origin: lease.origin,
    estoppelConfirmedAt: lease.estoppelConfirmedAt,
    depositTransferStatus: lease.depositTransferStatus,
    hasConditionBaseline: await hasConditionBaseline(lease.id),
  })
  if (gaps.length === 0) return { raised: 0, gaps: [] }

  const primary = lease.leaseTenants[0]?.tenant
  const who = primary ? `${primary.firstName} ${primary.lastName}` : 'the tenant'
  const where = `${lease.property.name} — ${lease.unit.name}`
  const on = businessDate(now, lease.property.timezone)

  let raised = 0
  for (const { gap } of gaps) {
    const { created } = await createTask(prisma, {
      propertyId: lease.propertyId,
      type: TASK_TYPE[gap],
      subjectType: 'Lease',
      subjectId: lease.id,
      businessDate: on,
      priority: 'URGENT',
      title: TASK_TITLE[gap](who, where),
    })
    if (created) raised += 1
  }

  return { raised, gaps: gaps.map((g) => g.gap) }
}

/// The gaps still open on a lease, resolved against the database. The read
/// side of the same question `raiseIntakeTasks` acts on.
export async function outstandingIntakeGaps(lease: {
  id: string
  origin: string
  estoppelConfirmedAt: Date | null
  depositTransferStatus: string
}) {
  return inheritedGaps({
    origin: lease.origin,
    estoppelConfirmedAt: lease.estoppelConfirmedAt,
    depositTransferStatus: lease.depositTransferStatus,
    hasConditionBaseline: await hasConditionBaseline(lease.id),
  })
}
