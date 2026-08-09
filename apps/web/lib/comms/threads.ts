import 'server-only'

import {
  type ThreadIdentity,
  type ThreadScope,
  threadKey,
} from '@rental/core/comms'
import { type Prisma, prisma } from '@rental/db'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'

// Thread resolution (COMM-01, R-017). One conversation per participant, got
// or created idempotently.

type Db = Prisma.TransactionClient | typeof prisma

/**
 * The thread for a participant, creating it on first contact.
 *
 * Create-then-catch-P2002, not find-then-create: two inbound texts arriving
 * together would both find nothing and both create, and the loser of that
 * race is a duplicate thread that permanently splits somebody's history.
 * `Thread.key`'s unique constraint is what makes the second one lose
 * harmlessly. Same pattern R-006 uses for JobRun and R-016 for its
 * idempotency key - the constraint IS the lock.
 */
export async function resolveThread(
  identity: ThreadIdentity,
  db: Db = prisma,
  subject?: string,
) {
  const key = threadKey(identity)

  const existing = await db.thread.findUnique({ where: { key } })
  if (existing) return existing

  try {
    return await db.thread.create({
      data: {
        key,
        propertyId: identity.propertyId,
        tenantId: identity.scope === 'TENANT' ? identity.tenantId : null,
        vendorId: identity.scope === 'VENDOR' ? identity.vendorId : null,
        // R-032: only ever set for the work-order-scoped vendor thread (see
        // threadKey's own comment) - the property-level vendor thread and
        // every tenant thread leave this null.
        workOrderId: identity.workOrderId ?? null,
        subject: subject ?? null,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Somebody else created it between the read and the write. Theirs is as
      // good as ours.
      return db.thread.findUniqueOrThrow({ where: { key } })
    }
    throw error
  }
}

/**
 * The property a tenant's conversation belongs to, via their most recent
 * lease.
 *
 * Returns null when a tenant has no lease at all - an applicant, or a record
 * created ahead of a tenancy. A thread cannot be created without a property
 * because `Thread.propertyId` is what every scope check filters on, so the
 * caller records the message as unrouted instead of inventing one.
 *
 * ponytail: "most recent" is by lease start date, which is right for the
 * ordinary case and arbitrary for a tenant holding two concurrent leases in
 * the same portfolio. `decideRoute` already refuses that case for inbound
 * messages; this only affects a staff member starting a thread from the UI,
 * where they can see which property they picked. Revisit if R-033 gives
 * leases a clearer notion of "current".
 */
export async function propertyForTenant(
  tenantId: string,
  db: Db = prisma,
): Promise<string | null> {
  const leaseTenant = await db.leaseTenant.findFirst({
    where: { tenantId },
    orderBy: { lease: { startsOn: 'desc' } },
    select: { lease: { select: { propertyId: true } } },
  })
  return leaseTenant?.lease.propertyId ?? null
}

/**
 * Every party whose phone number matches, for `decideRoute` to judge.
 *
 * Only ACTIVE tenants and vendors, and only tenants with a resolvable
 * property. A former tenant's number being reassigned to somebody else is a
 * real thing, and matching it would file a stranger's text into a closed
 * tenancy's record.
 */
export async function candidatesForPhone(e164: string, db: Db = prisma) {
  const [tenants, vendors] = await Promise.all([
    db.tenant.findMany({
      where: { phone: e164, active: true },
      select: {
        id: true,
        leaseTenants: {
          // LIVE leases only, and deliberately not `take: 1`.
          //
          // Filtering to live tenancies is what stops a tenant who moved
          // WITHIN the portfolio from looking ambiguous forever - their old
          // lease is ended, so only one property is in play and the message
          // routes.
          //
          // Not taking the first is what makes a tenant holding two
          // CONCURRENT leases refuse instead. Picking the most recent there
          // would file "the tap is dripping" against whichever house they
          // signed for last, which is a guess dressed as a fact - and the
          // property is what every RBAC check keys on. `decideRoute` sees
          // both and declines; see its own comment.
          where: {
            lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
          },
          orderBy: { lease: { startsOn: 'desc' } },
          select: { lease: { select: { propertyId: true } } },
        },
      },
    }),
    db.vendor.findMany({
      where: { phone: e164, active: true },
      select: { id: true, workOrders: { take: 1, select: { propertyId: true } } },
    }),
  ])

  const candidates: {
    scope: Extract<ThreadScope, 'TENANT' | 'VENDOR'>
    partyId: string
    propertyId: string
  }[] = []

  for (const tenant of tenants) {
    // One candidate per DISTINCT property they hold a live lease at. Two
    // leases at the same house (a renewal recorded as a new row) is one
    // candidate, not an ambiguity - decideRoute only refuses when the answer
    // genuinely differs.
    const properties = new Set(
      tenant.leaseTenants.map((row) => row.lease.propertyId),
    )
    for (const propertyId of properties) {
      candidates.push({ scope: 'TENANT', partyId: tenant.id, propertyId })
    }
  }
  for (const vendor of vendors) {
    // A vendor's conversation hangs off the property they were last sent to.
    // With no work order there is no property, so there is no thread to file
    // into - R-025 gives vendors real work orders and this stops being empty.
    const propertyId = vendor.workOrders[0]?.propertyId
    if (propertyId) {
      candidates.push({ scope: 'VENDOR', partyId: vendor.id, propertyId })
    }
  }

  return candidates
}
