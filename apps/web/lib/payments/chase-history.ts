import 'server-only'

import { type BusinessDate, businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'

// What the chase actually sent to this tenancy, and when (PAY-06; R-179).
//
// ==========================================================================
// "WHY DIDN'T THE GUARANTOR GET IT?" IS THE QUESTION THIS ANSWERS.
//
// The chase now addresses every liable party rather than the first name on
// the lease, which means "we sent the reminder" stopped being one fact. One
// party's email went, another's text was suppressed for want of consent, a
// third has no address on file at all — and the engine records every one of
// those, including the ones it deliberately did not send (a SUPPRESSED row
// is a row, for exactly this reason).
//
// So this is a READ, not a new table. `Notification` already holds the whole
// answer; nothing here writes anything, and R-179 added no migration.
// ==========================================================================

export interface ChaseHistoryRow {
  id: string
  /// Property-local calendar day the send was decided on (D-3). RAW, and
  /// typed so it stays raw: `friendlyBusinessDate` throws on anything that is
  /// not `YYYY-MM-DD`, so formatting here would turn D-153's guardrail into a
  /// 500 the moment the panel wrapped it. The renderer formats (D-154).
  onDate: BusinessDate
  who: string
  /// TENANT or GUARANTOR, spelled for a reader rather than for the enum.
  role: string
  channel: string
  toAddress: string
  /// QUEUED / SENT / SUPPRESSED / FAILED, and the reason when there is one.
  outcome: string
}

/**
 * Every rent chase addressed to anybody on this tenancy, newest first.
 *
 * SCOPED TO THE LEASE BY THE IDEMPOTENCY KEY, and it has to be: a tenant can
 * hold two tenancies (moving between units is the ordinary case), so their
 * recipient id alone would show one lease's chase under the other's heading.
 * `Notification` carries no `leaseId` column — the key does, because
 * `sendReminders` built it from the fact.
 */
export async function chaseHistoryForLease(
  leaseId: string,
  limit = 50,
): Promise<ChaseHistoryRow[]> {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      property: { select: { timezone: true } },
      leaseTenants: { select: { tenant: { select: { id: true, firstName: true, lastName: true } } } },
      guarantors: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  if (!lease) return []

  // RELEASED PARTIES INCLUDED, deliberately. A guarantor released last month
  // was still chased in March, and a history that quietly drops what was sent
  // to somebody who has since left is not a record of what happened.
  const names = new Map<string, { name: string; role: string }>()
  for (const { tenant } of lease.leaseTenants) {
    names.set(tenant.id, { name: `${tenant.firstName} ${tenant.lastName}`, role: 'Tenant' })
  }
  for (const guarantor of lease.guarantors) {
    names.set(guarantor.id, {
      name: `${guarantor.firstName} ${guarantor.lastName}`,
      role: 'Guarantor',
    })
  }
  if (names.size === 0) return []

  const rows = await prisma.notification.findMany({
    where: {
      category: 'rent_reminder',
      recipientId: { in: [...names.keys()] },
      recipientType: { in: ['TENANT', 'GUARANTOR'] },
    },
    select: {
      id: true,
      channel: true,
      recipientId: true,
      toAddress: true,
      createdAt: true,
      idempotencyKey: true,
      delivery: { select: { status: true, suppressedReason: true, failureCode: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * 4,
  })

  return rows
    // `reminder:` is the chase's own key prefix (`sendReminders`). The rent-DUE
    // notice is the same category and is keyed on a payer rather than a lease,
    // so it is not a per-tenancy chase record and is not shown as one.
    .filter((row) => row.idempotencyKey.startsWith('reminder:') && row.idempotencyKey.includes(leaseId))
    .slice(0, limit)
    .map((row) => {
      const who = names.get(row.recipientId)
      return {
        id: row.id,
        onDate: businessDate(row.createdAt, lease.property.timezone),
        who: who?.name ?? 'Someone no longer on this tenancy',
        role: who?.role ?? '—',
        channel: row.channel,
        toAddress: row.toAddress,
        outcome: describeOutcome(row.delivery),
      }
    })
}

/// WHY, not just what. "Suppressed" alone is the answer that starts the
/// support conversation rather than ending it — `no_consent` and `no_address`
/// need completely different responses, and one of them is ours to fix.
function describeOutcome(
  delivery: { status: string; suppressedReason: string | null; failureCode: string | null } | null,
): string {
  if (!delivery) return 'Decided, not yet queued'
  if (delivery.status === 'SUPPRESSED') {
    return `Not sent — ${(delivery.suppressedReason ?? 'no reason recorded').replace(/_/g, ' ')}`
  }
  if (delivery.status === 'FAILED') {
    return `Failed — ${delivery.failureCode ?? 'no reason recorded'}`
  }
  return delivery.status.charAt(0) + delivery.status.slice(1).toLowerCase()
}
