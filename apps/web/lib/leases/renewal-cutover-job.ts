import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { leaseTransition } from '@rental/core/leases'
import { businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { syncLease } from '@/lib/billing/lifecycle.ts'
import { provisionLeaseBilling } from '@/lib/billing/provision.ts'
import { SCHEDULED_JOBS } from '@/lib/jobs/runner.ts'
import { activateLeaseSideEffects } from './activate.ts'

// The renewal effective-date cutover (LEASE-09, R-065): "Given a signed
// renewal ..., when effective, then the ledger updates with no manual
// edits." A renewal successor lease finishes signing in
// `esign-actions.ts`'s `completeEnvelope` and, if its own effective date has
// not yet arrived, stays PENDING_SIGNATURE rather than activating - see that
// function's own comment for why (two live Stripe subscriptions on one unit
// at once is real double-billing, not a theoretical one). This job is what
// finally activates it, on its own start date, and ends the lease it
// replaces in the same transaction so the two rows never both read as the
// live tenancy.
const LOCAL_HOUR = 3

SCHEDULED_JOBS.push({
  type: 'lease.renewal_cutover',
  localHour: LOCAL_HOUR,
  description:
    "Activates a fully-signed renewal successor lease on its own effective date and ends the lease it replaces (LEASE-09).",
  run: async ({ propertyId, businessDate }) => {
    const asOf = businessDateToUtc(businessDate)

    const due = await prisma.lease.findMany({
      where: {
        propertyId,
        status: 'PENDING_SIGNATURE',
        renewedFromLeaseId: { not: null },
        startsOn: { lte: asOf },
        // R-090: `kind` matters, and this is the query that would have
        // done real damage without it - a completed party-change amendment
        // is a COMPLETED envelope on the lease, and would have satisfied
        // "the renewal has been signed" for a renewal nobody had signed.
        envelopes: { some: { kind: 'LEASE', status: 'COMPLETED' } },
      },
      select: {
        id: true,
        unitId: true,
        propertyId: true,
        renewedFromLeaseId: true,
        renewedFrom: { select: { id: true, status: true } },
        leaseTenants: { select: { id: true } },
        rentCents: true,
        startsOn: true,
        endsOn: true,
        isMonthToMonth: true,
      },
    })

    let activated = 0
    for (const successor of due) {
      const toActive = leaseTransition(
        {
          status: 'PENDING_SIGNATURE',
          tenantCount: successor.leaseTenants.length,
          rentCents: successor.rentCents,
          startsOn: successor.startsOn,
          endsOn: successor.endsOn,
          isMonthToMonth: successor.isMonthToMonth,
        },
        'ACTIVE',
      )
      // The predecessor has to still be the live tenancy for this cutover to
      // make sense - if staff already terminated it for cause ahead of the
      // renewal's own start date, the successor is now stale and this job
      // logs rather than guessing what should happen to it.
      const predecessorStillLive =
        successor.renewedFrom?.status === 'ACTIVE' || successor.renewedFrom?.status === 'MONTH_TO_MONTH'
      if (!toActive.allowed || !predecessorStillLive) {
        console.error(
          `[lease] renewal cutover skipped for ${successor.id}: ${!toActive.allowed ? toActive.message : `predecessor ${successor.renewedFromLeaseId} is ${successor.renewedFrom?.status}`}`,
        )
        continue
      }

      await prisma.$transaction(async (tx) => {
        await activateLeaseSideEffects(tx, {
          id: successor.id,
          unitId: successor.unitId,
          propertyId: successor.propertyId,
        })
        await tx.lease.update({
          where: { id: successor.id },
          data: { status: 'ACTIVE', activatedAt: new Date() },
        })
        // Same "no MAKE_READY, no moveOutAt" reasoning as completeEnvelope's
        // own same-day case - the tenant never left, only the lease row did.
        await tx.lease.update({
          where: { id: successor.renewedFromLeaseId! },
          data: { status: 'ENDED' },
        })
        await recordAudit(tx, {
          actor: { type: 'SYSTEM', ref: 'lease.renewal_cutover' },
          action: 'lease.renewed',
          entityType: 'Lease',
          entityId: successor.id,
          propertyId,
          after: { renewedFromLeaseId: successor.renewedFromLeaseId, effectiveOn: successor.startsOn.toISOString() },
        })
      })

      await provisionLeaseBilling(successor.id).catch((error: unknown) => {
        console.error(`[lease] billing provisioning failed for renewal ${successor.id}`, error)
      })
      await syncLease(successor.renewedFromLeaseId!).catch((error: unknown) => {
        console.error(`[lease] billing sync failed for predecessor ${successor.renewedFromLeaseId}`, error)
      })
      activated++
    }

    return { checked: due.length, activated }
  },
})
