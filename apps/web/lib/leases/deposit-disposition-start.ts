import 'server-only'

import {
  addBusinessDays,
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { createTask } from '@/lib/tasks/create.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// Starts the statutory countdown "from the recorded move-out date" (INSP-03,
// R-071) - `Lease.moveOutAt`, the real fact `changeLeaseStatus` stamps on
// the way to ENDED/TERMINATED, never the merely-planned `noticeEffectiveOn`
// (R-070). Best-effort, called the same way `chargeDeposit()`/`syncLease()`
// already are right after that transition commits - a jurisdiction lookup
// failing must not undo a tenancy ending.
//
// FROZEN ONCE, NEVER RECOMPUTED (D-12, the schema's own comment on
// `dispositionDueOn`): a later JurisdictionRule version must not move a
// deadline already running, so this is a no-op the moment the field is
// already set.

export interface StartDispositionResult {
  reason: 'started' | 'no_deposit' | 'already_started' | 'no_rule_configured'
}

export async function startDepositDisposition(leaseId: string): Promise<StartDispositionResult> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      moveOutAt: true,
      noticeForwardingAddress: true,
      property: { select: { state: true, county: true } },
      unit: { select: { name: true } },
      deposits: { select: { id: true, dispositionDueOn: true }, take: 1 },
    },
  })
  const deposit = lease.deposits[0]
  if (!deposit || !lease.moveOutAt) return { reason: 'no_deposit' }
  if (deposit.dispositionDueOn != null) return { reason: 'already_started' }

  const rule = await rulesFor(lease.property, new Date()).catch(() => null)
  if (!rule?.depositDispositionDays) return { reason: 'no_rule_configured' }

  const moveOutDate = utcToBusinessDate(lease.moveOutAt)
  const dueOn = addBusinessDays(moveOutDate, rule.depositDispositionDays)

  await prisma.$transaction(async (tx) => {
    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        dispositionDueOn: businessDateToUtc(dueOn),
        // Snapshotted here, not read live later - `Lease.noticeForwardingAddress`'s
        // own comment already explains why (a tenant who has moved is not
        // reliably reachable to ask again), and this is the same "freeze
        // the fact, never re-derive it" posture `dispositionDueOn` itself
        // takes.
        forwardingAddress: lease.noticeForwardingAddress,
      },
    })
    await createTask(tx, {
      propertyId: lease.propertyId,
      type: 'deposit.disposition_due',
      subjectType: 'Lease',
      subjectId: lease.id,
      businessDate: moveOutDate,
      priority: 'ROUTINE',
      title: `Deposit disposition due ${friendlyBusinessDate(dueOn)} — ${lease.unit.name}`,
    })
  })

  return { reason: 'started' }
}
