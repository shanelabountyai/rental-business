'use server'

import { parseLeaseDate, validateLease, validateRenewalOverride } from '@rental/core/leases'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { renewalRentCheckFor } from './renewal-check.ts'
import {
  retaliationAckAudit,
  retaliationAckView,
  retaliationGateFor,
  type RetaliationAckView,
} from './retaliation-check.ts'

// Offering a renewal (LEASE-09, R-065). A fixed-term renewal is a NEW Lease
// row, never a mutation of the one it replaces - packages/core/leases/status.ts's
// own comment states why (MTM rollover is one-way; agreeing a new fixed term
// is always a new lease). This action creates that successor as an ordinary
// DRAFT, copies over its tenants, and stops there: generating the document
// and sending it for signature is R-063's existing `generateAndSendLease`,
// unchanged, on the lease detail page it already renders for any DRAFT.
//
// The rent-increase check is the one thing genuinely new here - see
// packages/core/leases/renewal.ts's own header for why a statutory CAP
// blocks outright while a NOTICE-PERIOD shortfall only warns.
//
// R-212: and the RETALIATION guard, which this path went without for its
// first year while the direct rent edit had it. That was backwards - the
// renewal offer is how nearly every rent increase in a portfolio reaches a
// tenant, so the guard was armed on the rare path and off on the routine
// one.

export interface RenewalFormState {
  error?: string
  fieldErrors?: Record<string, string>
  /// A cap violation - no override exists, shown so staff can offer the
  /// number that WOULD be legal instead of guessing at one.
  capped?: { capPercentBps: number; maxAllowedCents: number }
  /// A notice-period shortfall - staff may proceed with a stated reason.
  needsOverride?: { requiredNoticeDays: number; noticeDaysGiven: number; shortfallDays: number }
  /// RISK-06 (R-055, R-212) - an increase inside the retaliation window.
  needsRetaliationAck?: RetaliationAckView
  /// Echoed back on every early return - React 19 resets uncontrolled
  /// fields once a form action completes (ScheduleForm's own comment on the
  /// identical fact), which would otherwise wipe the very rent the warning
  /// is about.
  values?: {
    startsOn: string
    endsOn: string
    rentDollars: string
    overrideReason?: string
    retaliationReason?: string
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): RenewalFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

export async function offerRenewal(
  leaseId: string,
  _previous: RenewalFormState,
  formData: FormData,
): Promise<RenewalFormState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    include: {
      property: { select: { id: true, legalEntityId: true, state: true, county: true, timezone: true } },
      leaseTenants: { select: { tenantId: true, isPrimary: true } },
    },
  })
  const actor = await requirePermission('lease.write', propertyResource(lease.property))

  if (lease.status !== 'ACTIVE' && lease.status !== 'MONTH_TO_MONTH') {
    return { error: 'Only a running lease can be offered a renewal.' }
  }

  const existingSuccessor = await prisma.lease.findFirst({
    where: { renewedFromLeaseId: leaseId, status: { in: ['DRAFT', 'PENDING_SIGNATURE', 'ACTIVE'] } },
    select: { id: true },
  })
  if (existingSuccessor) {
    return { error: 'A renewal is already in progress for this lease.' }
  }

  const input = {
    unitId: lease.unitId,
    startsOn: str(formData, 'startsOn'),
    endsOn: str(formData, 'endsOn') || null,
    rentDollars: str(formData, 'rentDollars'),
    depositDollars: (lease.depositCents / 100).toString(),
    nsfFeeDollars: lease.nsfFeeCents != null ? (lease.nsfFeeCents / 100).toString() : null,
    depositArrangement: lease.depositArrangement,
    rentDueDay: String(lease.rentDueDay),
    isMonthToMonth: false,
    mtmRentDollars: lease.mtmRentCents != null ? (lease.mtmRentCents / 100).toString() : null,
  }
  const values = { startsOn: input.startsOn, endsOn: input.endsOn ?? '', rentDollars: input.rentDollars }
  const violations = validateLease(input)
  // A fixed-term renewal has to actually name a new term - the auto MTM
  // rollover (this item's own nightly job) is the path for "no new term
  // agreed", so an offer with no end date is not a smaller version of this
  // action, it is a different one.
  if (!input.endsOn) {
    violations.push({ field: 'endsOn', message: 'A renewal needs a new end date.' })
  }
  if (violations.length > 0) return { ...violationsToState(violations), values }

  const startsOn = parseLeaseDate(input.startsOn)!
  const rentCents = Math.round(Number(input.rentDollars) * 100)
  const overrideReason = str(formData, 'overrideReason') || null
  const retaliationReason = str(formData, 'retaliationReason') || null
  const now = new Date()

  // R-200: both ends read into the property's own calendar before the check,
  // and with the reader each one actually needs - `startsOn` is a `@db.Date`
  // value (UTC midnight), `now` is a real instant. Dividing one by the other
  // is what made this report a day less notice than the offer gave.
  const decision = await renewalRentCheckFor({
    propertyState: lease.property.state,
    propertyCounty: lease.property.county,
    currentRentCents: lease.rentCents,
    proposedRentCents: rentCents,
    effectiveOn: utcToBusinessDate(startsOn),
    offeredOn: businessDate(now, lease.property.timezone),
  })

  if (decision.blocked) {
    return {
      error: `A ${(decision.increasePercentBps / 100).toFixed(1)}% increase exceeds the ${(decision.capPercentBps! / 100).toFixed(1)}% statutory cap for ${lease.property.state}.`,
      capped: { capPercentBps: decision.capPercentBps!, maxAllowedCents: decision.maxAllowedCents! },
      values,
    }
  }
  const overrideViolations = decision.needsOverride ? validateRenewalOverride(overrideReason) : []

  // An INCREASE only - a renewal at the same rent or lower is not the
  // adverse action the guard exists for, and warning on every routine
  // renewal would train staff to type through it. `now`, not `startsOn`: the
  // act a retaliation claim is about is making the offer.
  const gate =
    rentCents > lease.rentCents
      ? await retaliationGateFor({
          leaseId,
          property: lease.property,
          actionDate: now,
          action: 'renewal increase',
          reason: retaliationReason,
        })
      : { warning: null, refusal: null }

  // NOTHING is written on either refusal - same posture as R-027's
  // entry-notice override: saving the offer and asking for the reason
  // afterwards would leave an unexplained increase on the record if the
  // second step never happened. And BOTH warnings come back whenever either
  // refuses, with both reasons echoed, or each press drops the field the
  // other one asked for (the loop R-212 found on the notice path).
  if (overrideViolations.length > 0 || gate.refusal) {
    return {
      error:
        overrideViolations.length > 0
          ? `This offer gives ${decision.noticeDaysGiven} days' notice, ${decision.shortfallDays} short of the ${decision.requiredNoticeDays}-day requirement for ${lease.property.state}.`
          : gate.refusal!.error,
      fieldErrors: {
        ...Object.fromEntries(overrideViolations.map((v) => [v.field, v.message])),
        ...gate.refusal?.fieldErrors,
      },
      needsOverride: decision.needsOverride
        ? {
            requiredNoticeDays: decision.requiredNoticeDays!,
            noticeDaysGiven: decision.noticeDaysGiven!,
            shortfallDays: decision.shortfallDays!,
          }
        : undefined,
      needsRetaliationAck: gate.warning
        ? retaliationAckView(gate.warning, lease.property.timezone)
        : undefined,
      values: {
        ...values,
        overrideReason: overrideReason ?? '',
        retaliationReason: retaliationReason ?? '',
      },
    }
  }

  const successor = await prisma.$transaction(async (tx) => {
    const created = await tx.lease.create({
      data: {
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        status: 'DRAFT',
        origin: 'RENEWAL',
        renewedFromLeaseId: lease.id,
        depositTransferStatus: 'NOT_APPLICABLE',
        startsOn,
        endsOn: parseLeaseDate(input.endsOn!),
        rentCents,
        rentDueDay: lease.rentDueDay,
        prorationMethod: lease.prorationMethod,
        // The deposit already held under the predecessor lease is not
        // recollected - see this item's own PROGRESS entry for the Deposit
        // continuity gap this leaves. Carried here only as the FIGURE this
        // lease's own record states, not as a new liability row.
        depositCents: lease.depositCents,
        depositArrangement: lease.depositArrangement,
        nsfFeeCents: lease.nsfFeeCents,
        requireFullBalance: lease.requireFullBalance,
        isMonthToMonth: false,
        mtmRentCents: lease.mtmRentCents,
        utilityResponsibility: lease.utilityResponsibility ?? undefined,
      },
    })
    for (const lt of lease.leaseTenants) {
      await tx.leaseTenant.create({
        data: { leaseId: created.id, tenantId: lt.tenantId, isPrimary: lt.isPrimary },
      })
    }
    await tx.task.updateMany({
      where: { type: 'lease_renewal', subjectId: lease.id, status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } },
      data: { status: 'DONE', completedByStaffId: actor.id, completedAt: now },
    })
    await audit(
      {
        action: 'lease.renewal_offered',
        entityType: 'Lease',
        entityId: created.id,
        propertyId: lease.propertyId,
        after: {
          renewedFromLeaseId: lease.id,
          currentRentCents: lease.rentCents,
          proposedRentCents: rentCents,
          startsOn: startsOn.toISOString(),
          endsOn: parseLeaseDate(input.endsOn!)!.toISOString(),
        },
      },
      tx,
    )
    if (decision.needsOverride) {
      await audit(
        {
          action: 'lease.renewal_rent_check_overridden',
          entityType: 'Lease',
          entityId: created.id,
          propertyId: lease.propertyId,
          after: {
            requiredNoticeDays: decision.requiredNoticeDays,
            noticeDaysGiven: decision.noticeDaysGiven,
            shortfallDays: decision.shortfallDays,
          },
          reasonCode: 'owner_directive',
          reason: overrideReason!,
        },
        tx,
      )
    }
    if (gate.warning) {
      // Against the PREDECESSOR: it is the tenancy the complaint was made
      // under, and the lease a retaliation defence will be asked about. The
      // successor is a DRAFT that may never be signed.
      await audit(
        retaliationAckAudit({
          warning: gate.warning,
          reason: retaliationReason!,
          leaseId: lease.id,
          propertyId: lease.propertyId,
          trigger: 'renewal_increase',
          details: {
            renewalLeaseId: created.id,
            fromCents: lease.rentCents,
            toCents: rentCents,
          },
        }),
        tx,
      )
    }
    return created
  })

  revalidatePath(`/leases/${leaseId}`)
  redirect(`/leases/${successor.id}`)
}
