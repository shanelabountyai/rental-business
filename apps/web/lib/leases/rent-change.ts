import 'server-only'

import { renewalRentCheck, rentIncreaseNoticeText } from '@rental/core/leases'
import { formatCents } from '@rental/core/money'
import {
  UNREVIEWED_DAY_COUNT,
  businessDate,
  businessDateToUtc,
  friendlyBusinessDate,
  utcToBusinessDate,
  type BusinessDate,
} from '@rental/core/scheduling'
import { prisma, type Prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { authUrl, canReceiveAuthLink } from '@/lib/auth/delivery.ts'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// A rent increase on a running tenancy (LEASE-09, R-225; review 2026-09-17
// finding 4). The renewal offer already ran the cap and notice-period
// checks; the lease edit form - the ONLY way to raise rent on a
// month-to-month tenancy, the population `lease.mtm_rollover` grows every
// night - ran neither, wrote `rentCents` at once, and `syncLease` pushed it to
// the next invoice. Now the form plans the raise here with the same
// `renewalRentCheck`, drafts a RENT_INCREASE notice, and leaves `rentCents`
// alone until `rent-change-job.ts` applies it on the effective date.

type Tx = Prisma.TransactionClient

export interface RentLease {
  id: string
  propertyId: string
  unitId: string
  rentCents: number
  property: { timezone: string; state: string; county: string | null; addressLine1: string }
}

export interface ScheduledRaise {
  fromCents: number
  toCents: number
  effectiveOn: BusinessDate
  overrideReason: string | null
  noticeShortfall?: NoticeShortfall
  jurisdictionRuleId: string | null
  rentIncreaseNoticeDays: number | null
}

interface NoticeShortfall {
  requiredNoticeDays: number
  noticeDaysGiven: number
  shortfallDays: number
}

export interface RaisePlan {
  raise?: ScheduledRaise
  refusal?: { error: string; fieldErrors: Record<string, string> }
  noticeShortfall?: NoticeShortfall
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Decides whether a typed raise may be scheduled. Writes nothing.
 *
 * A statutory cap blocks outright; a notice shortfall needs a stated reason
 * (`renewal.ts`'s header gives both postures).
 */
export async function planRentIncrease(args: {
  lease: RentLease
  toCents: number
  effectiveOn: string
  noticeReason: string | null
}): Promise<RaisePlan> {
  const { lease } = args
  const refuse = (field: string, message: string, error = 'Fix the highlighted fields.'): RaisePlan => ({
    refusal: { error, fieldErrors: { [field]: message } },
  })

  // Only a real calendar day reaches the check - `<input type="date">` sends
  // nothing else, but a hand-made POST can (CLAUDE.md's BusinessDate note).
  if (!DAY.test(args.effectiveOn) || Number.isNaN(Date.parse(args.effectiveOn))) {
    return refuse('rentEffectiveOn', 'A rent increase needs the day the new rent starts.')
  }
  const effectiveOn = args.effectiveOn as BusinessDate
  const today = businessDate(new Date(), lease.property.timezone)
  // After today, not on it: the cutover runs at 03:00 and the day's invoice
  // is cut at 09:00, so a same-day start would already have missed the job.
  if (effectiveOn <= today) {
    return refuse('rentEffectiveOn', 'The new rent has to start after today. The tenant is told first.')
  }

  const pending = await prisma.rentChange.findFirst({
    where: { leaseId: lease.id, status: 'SCHEDULED' },
    select: { toCents: true, effectiveOn: true },
  })
  if (pending) {
    return refuse(
      'rentDollars',
      `A rent increase to ${formatCents(pending.toCents)} is already scheduled. Cancel it before scheduling another.`,
    )
  }

  // An unconfigured jurisdiction fails OPEN, same as `renewalRentCheckFor`:
  // no rule means neither statutory number is on file.
  const rule = await rulesForConfigured(
    { state: lease.property.state, county: lease.property.county },
    businessDateToUtc(today),
  )
  const decision = renewalRentCheck({
    currentRentCents: lease.rentCents,
    proposedRentCents: args.toCents,
    effectiveOn,
    offeredOn: today,
    rentIncreaseCapPercentBps: rule?.rentIncreaseCapPercentBps ?? null,
    rentIncreaseNoticeDays: rule?.rentIncreaseNoticeDays ?? null,
    dayCount: rule ?? UNREVIEWED_DAY_COUNT,
  })

  if (decision.blocked) {
    return refuse(
      'rentDollars',
      `The most this may legally increase to is ${formatCents(decision.maxAllowedCents!)}/mo.`,
      `A ${(decision.increasePercentBps / 100).toFixed(1)}% increase exceeds the ${(decision.capPercentBps! / 100).toFixed(1)}% statutory cap for ${lease.property.state}.`,
    )
  }

  const noticeShortfall = decision.needsOverride
    ? {
        requiredNoticeDays: decision.requiredNoticeDays!,
        noticeDaysGiven: decision.noticeDaysGiven!,
        shortfallDays: decision.shortfallDays!,
      }
    : undefined
  if (noticeShortfall && !args.noticeReason) {
    return {
      noticeShortfall,
      refusal: {
        error: `This gives ${noticeShortfall.noticeDaysGiven} days' notice, ${noticeShortfall.shortfallDays} short of the ${noticeShortfall.requiredNoticeDays}-day requirement for ${lease.property.state}. The earliest lawful start is ${friendlyBusinessDate(decision.earliestOn!)}.`,
        fieldErrors: {
          rentNoticeReason:
            "This gives less than the state's required notice for a rent increase. State why - it is recorded.",
        },
      },
    }
  }

  return {
    noticeShortfall,
    raise: {
      fromCents: lease.rentCents,
      toCents: args.toCents,
      effectiveOn,
      overrideReason: noticeShortfall ? args.noticeReason : null,
      noticeShortfall,
      jurisdictionRuleId: rule?.id ?? null,
      rentIncreaseNoticeDays: rule?.rentIncreaseNoticeDays ?? null,
    },
  }
}

/**
 * Writes the RENT_INCREASE notice and the scheduled change, inside the
 * caller's transaction. Served through the portal at once when the tenant
 * can reach it - the same predicate the non-renewal notice uses (R-210) -
 * and left unserved otherwise, which the cutover job then refuses to apply.
 */
export async function scheduleRentIncrease(
  tx: Tx,
  args: { lease: RentLease; raise: ScheduledRaise; actorStaffId: string },
): Promise<string> {
  const { lease, raise } = args
  const parties = await tx.leaseTenant.findMany({
    where: { leaseId: lease.id },
    orderBy: { isPrimary: 'desc' },
    select: {
      tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    },
  })
  const primary = parties[0]?.tenant
  const unit = await tx.unit.findUnique({ where: { id: lease.unitId }, select: { name: true } })
  const servedToPortal = primary ? await canReceiveAuthLink('TENANT', primary) : false
  const now = new Date()

  const notice = await tx.notice.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      type: 'RENT_INCREASE',
      addressOfRecord: lease.property.addressLine1,
      bodyText: rentIncreaseNoticeText({
        tenantName: parties.map((p) => `${p.tenant.firstName} ${p.tenant.lastName}`).join(', ') || 'Occupant',
        addressLine1: lease.property.addressLine1,
        unitName: unit?.name ?? '',
        fromCents: raise.fromCents,
        toCents: raise.toCents,
        effectiveOn: raise.effectiveOn,
        rentIncreaseNoticeDays: raise.rentIncreaseNoticeDays,
      }),
      serviceMethod: servedToPortal ? 'PORTAL' : null,
      servedAt: servedToPortal ? now : null,
      servedByStaffId: servedToPortal ? args.actorStaffId : null,
      jurisdictionRuleId: raise.jurisdictionRuleId,
    },
  })
  if (servedToPortal) {
    await tx.noticeDelivery.create({
      data: {
        noticeId: notice.id,
        method: 'PORTAL',
        servedAt: now,
        servedByStaffId: args.actorStaffId,
        jurisdictionRuleId: raise.jurisdictionRuleId,
      },
    })
  }
  await audit(
    {
      action: servedToPortal ? 'notice.served' : 'notice.drafted',
      entityType: 'Notice',
      entityId: notice.id,
      propertyId: lease.propertyId,
      after: {
        type: 'RENT_INCREASE',
        serviceMethod: servedToPortal ? 'PORTAL' : null,
        unservedReason: servedToPortal ? null : 'no_portal_sign_in',
        effectiveOn: raise.effectiveOn,
        jurisdictionRuleId: raise.jurisdictionRuleId,
      },
    },
    tx,
  )

  const change = await tx.rentChange.create({
    data: {
      leaseId: lease.id,
      propertyId: lease.propertyId,
      fromCents: raise.fromCents,
      toCents: raise.toCents,
      effectiveOn: businessDateToUtc(raise.effectiveOn),
      noticeId: notice.id,
      overrideReason: raise.overrideReason,
    },
  })
  await audit(
    {
      action: 'lease.rent_increase_scheduled',
      entityType: 'Lease',
      entityId: lease.id,
      propertyId: lease.propertyId,
      after: {
        rentChangeId: change.id,
        noticeId: notice.id,
        fromCents: raise.fromCents,
        toCents: raise.toCents,
        effectiveOn: raise.effectiveOn,
      },
    },
    tx,
  )
  if (raise.noticeShortfall) {
    await audit(
      {
        action: 'lease.rent_increase_notice_overridden',
        entityType: 'Lease',
        entityId: lease.id,
        propertyId: lease.propertyId,
        after: { rentChangeId: change.id, ...raise.noticeShortfall },
        reasonCode: 'owner_directive',
        reason: raise.overrideReason!,
      },
      tx,
    )
  }
  return change.id
}

/** Tells the tenant, outside the transaction (R-016's rule). */
export async function notifyRentIncrease(rentChangeId: string): Promise<void> {
  try {
    const change = await prisma.rentChange.findUniqueOrThrow({
      where: { id: rentChangeId },
      select: {
        toCents: true,
        effectiveOn: true,
        noticeId: true,
        notice: { select: { servedAt: true } },
        lease: {
          select: {
            propertyId: true,
            property: { select: { addressLine1: true } },
            leaseTenants: {
              where: { isPrimary: true },
              select: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
            },
          },
        },
      },
    })
    const tenant = change.lease.leaseTenants[0]?.tenant
    // An unserved notice has no portal page to link to; staff serve it.
    if (!tenant || !change.notice.servedAt) return
    const outcomes = await notify({
      category: 'legal_notice',
      templateKey: 'lease.rent_increase',
      recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
      context: {
        tenantName: tenant.firstName,
        addressLine1: change.lease.property.addressLine1,
        toCents: change.toCents,
        effectiveOn: utcToBusinessDate(change.effectiveOn),
        url: authUrl(`/portal/notices/${change.noticeId}`),
      },
      propertyId: change.lease.propertyId,
      idempotencyKey: `rent-increase:${change.noticeId}`,
    })
    await dispatchPendingNotifications(new Date(), 100, {
      deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
    })
  } catch (error) {
    console.error(`[leases] failed to notify tenant of rent increase ${rentChangeId}`, error)
  }
}
