import 'server-only'

import { type CurePayment, cureClock, cureVerdict, cureVerdictSentence } from '@rental/core/evictions'
import {
  type DayCountRule,
  UNREVIEWED_DAY_COUNT,
  businessDate,
  businessDaysBetween,
  friendlyBusinessDate,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// Lifting a served notice's late-fee stop (R-227, review 2026-09-17 finding 6).
//
// R-213 stopped the meter at service and nothing ever started it again, so a
// tenant served once and cured the same week was never charged a late fee for
// the rest of the tenancy - the fee policy enforced on some tenants and not on
// others, split by whoever had once been served. D-231 left the lift to a
// person on the argument that nothing decides when a notice stops mattering.
// R-194's verdict and the case's own close are exactly that decision.
//
// Run by the late-fee job, BEFORE it reads holds, so the night a notice is
// settled is the first night its tenancy is assessed again. The days the hold
// covered are never charged (`lateFeeOutsideHolds`): the lift resumes the
// meter, it does not backfill it.

/// Who lifted it, on the row and in the audit trail - a job, not a person.
export const NOTICE_HOLD_LIFTER = 'job:ledger.late_fees'

/**
 * Lift every live `NOTICE_SERVED` hold on this property whose notice is
 * settled: cured, past its last day to cure, or on a closed case. Returns how
 * many it lifted.
 *
 * A hold with no notice (placed by hand, for a notice served outside the
 * product) is left for a person: there is no verdict here to read.
 */
export async function liftSettledNoticeHolds(propertyId: string, now: Date): Promise<number> {
  const holds = await prisma.leaseHold.findMany({
    where: { propertyId, type: 'NOTICE_SERVED', liftedAt: null, noticeId: { not: null } },
    select: {
      id: true,
      leaseId: true,
      placedAt: true,
      notice: {
        select: {
          id: true,
          generatedAt: true,
          demandedCents: true,
          evictionCase: { select: { closedAt: true } },
          deliveries: { select: { servedAt: true, permittedByJurisdiction: true } },
        },
      },
    },
  })
  if (holds.length === 0) return 0

  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { state: true, county: true, timezone: true },
  })
  // Resolved as `cureClockFor` resolves it: an unconfigured state has no cure
  // period, so its clock never expires and only a cure or a closed case lifts.
  let payOrQuitDays: number | null = null
  let dayCount: DayCountRule = UNREVIEWED_DAY_COUNT
  try {
    const rule = await rulesFor(property, now)
    payOrQuitDays = rule.payOrQuitDays
    dayCount = rule
  } catch {
    payOrQuitDays = null
  }
  const today = businessDate(now, property.timezone)

  let lifted = 0
  for (const hold of holds) {
    const notice = hold.notice!
    let settled: string | null = null

    if (notice.evictionCase?.closedAt) {
      settled = `The eviction case this notice belongs to closed on ${friendlyBusinessDate(businessDate(notice.evictionCase.closedAt, property.timezone))}.`
    } else {
      const clock = cureClock(
        notice.deliveries.map((delivery) => ({
          servedOn: businessDate(delivery.servedAt, property.timezone),
          permittedByJurisdiction: delivery.permittedByJurisdiction,
        })),
        payOrQuitDays,
        today,
        dayCount,
      )
      // KEPT money only - R-156's definition, the one the case page's verdict
      // reads, so the lift and the screen cannot disagree about a cure.
      const payments: CurePayment[] = (
        await prisma.payment.findMany({
          where: { leaseId: hold.leaseId, status: { in: ['PENDING', 'SETTLED'] }, reversedAt: null },
          select: { amountCents: true, receivedAt: true },
        })
      ).map((p) => ({ receivedOn: businessDate(p.receivedAt, property.timezone), amountCents: p.amountCents, channelLabel: '' }))
      const verdict = cureVerdict(
        notice.demandedCents,
        payments,
        businessDate(notice.generatedAt, property.timezone),
        clock.cureBy,
      )
      if (verdict.state === 'cured') {
        settled = cureVerdictSentence(verdict, clock.state)
      } else if (clock.state === 'expired' && clock.cureBy) {
        settled = `The cure period ended on ${friendlyBusinessDate(clock.cureBy)}. ${cureVerdictSentence(verdict, clock.state)}`
      }
    }
    if (!settled) continue

    const heldDays = businessDaysBetween(businessDate(hold.placedAt, property.timezone), today)
    const liftReason = `${settled} Late fees resume from ${friendlyBusinessDate(today)}; the ${heldDays} day${heldDays === 1 ? '' : 's'} they were stopped are not charged.`
    const done = await prisma.$transaction(async (tx) => {
      // Guarded on `liftedAt: null`: a person lifting it by hand since the
      // read above keeps their own lift, reason and name.
      const { count } = await tx.leaseHold.updateMany({
        where: { id: hold.id, liftedAt: null },
        data: { liftedAt: now, liftedBySystem: NOTICE_HOLD_LIFTER, liftReason },
      })
      if (count === 0) return false
      await auditAsSystem(
        NOTICE_HOLD_LIFTER,
        {
          action: 'lease.hold_lifted',
          entityType: 'Lease',
          entityId: hold.leaseId,
          propertyId,
          reason: liftReason,
          after: { holdId: hold.id, type: 'notice_served', noticeId: notice.id, heldDays },
        },
        tx,
      )
      return true
    })
    if (done) lifted += 1
  }
  return lifted
}
