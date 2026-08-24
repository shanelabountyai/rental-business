'use server'

import {
  type LeaseStatusValue,
  type NoticePartyValue,
  type RetaliationWarning,
  canGiveNotice,
  leaseCents,
  leaseIsInForce,
  leaseTransition,
  nonRenewalNoticeText,
  noticePeriodCheck,
  parseLeaseDate,
  validateGuarantor,
  validateJustCauseStatement,
  validateLease,
  validateNoticePeriodOverride,
  validateRetaliationAck,
} from '@rental/core/leases'
import { validateDepositAmount } from '@rental/core/ledger'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { syncLease } from '@/lib/billing/lifecycle.ts'
import { provisionLeaseBilling } from '@/lib/billing/provision.ts'
import { startDepositDisposition } from '@/lib/leases/deposit-disposition-start.ts'
import { revokeTenantLockCodes } from '@/lib/locks/tenant-codes.ts'
import { startTurnoverProjectForLease } from '@/lib/turnover/start.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { activateLeaseSideEffects } from './activate.ts'
import { raiseIntakeTasks } from './intake.ts'
import { retaliationCheckFor } from './retaliation-check.ts'

// Writes for lease records (LEASE-06, RISK-08, R-033). Same shape as every
// other lib/*/actions.ts in this repo: a resource-carrying permission check
// first, then a transaction pairing the write with its audit entry.
//
// EVERY status change goes through `leaseTransition()` in packages/core.
// Nothing here sets `status` directly - see that module's header for why a
// guarded machine, rather than a column anybody can assign, is what keeps
// R-034's billing and R-071's deposit clock from each having to defend
// themselves against states that should have been impossible.

export interface LeaseFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
  /// RISK-06 (R-055). Present when the action is inside the property's
  /// retaliation-presumption window and no reason has been given yet -
  /// nothing was written; see `retaliationCheckFor`'s own header for why.
  needsRetaliationAck?: {
    category: string
    /// ISO date only, in the property's own timezone (D-3) - the warning is
    /// read by a human, not recomputed from it.
    occurredOn: string
    daysAgo: number
    windowDays: number
  }
  /// R-066 (LEASE-11). Present when notice to end the tenancy gives less
  /// than the jurisdiction's configured `noticeToVacateDays` and no reason
  /// has been given yet - same shape `needsRetaliationAck` gives its own
  /// warning, and the two can fire together on one notice.
  needsNoticePeriodAck?: {
    daysGiven: number
    requiredDays: number
    shortfallDays: number
  }
  /// What was actually typed, echoed back on the retaliation early return.
  /// React 19 resets an uncontrolled field's DOM value once a form action
  /// completes (see ScheduleForm's own comment on the same fact) - without
  /// this, the rent increase that TRIGGERED the warning would be wiped from
  /// the field showing it, and "save anyway" would silently save the OLD
  /// rent instead of the one the warning is about.
  values?: Record<string, string>
}

function retaliationAckView(warning: RetaliationWarning, timezone: string) {
  return {
    category: warning.category,
    occurredOn: businessDate(warning.occurredAt, timezone),
    daysAgo: warning.daysAgo,
    windowDays: warning.windowDays,
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): LeaseFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

/// The lease plus the permission check for writing to it, against ITS OWN
/// property. A lease id copied from somewhere it should not have been is
/// refused by `requirePermission`, because a property-scoped manager's grant
/// only matches when the resource names a property they actually hold - the
/// id itself is never the authorization.
async function leaseForWrite(leaseId: string) {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    include: {
      property: {
        select: {
          id: true,
          legalEntityId: true,
          timezone: true,
          state: true,
          county: true,
          addressLine1: true,
        },
      },
      leaseTenants: { select: { id: true } },
    },
  })
  const actor = await requirePermission('lease.write', propertyResource(lease.property))
  return { lease, actor }
}

/**
 * Creates a tenancy record.
 *
 * Always DRAFT. There is no "create it already active" shortcut, including
 * for the inherited path: activation has preconditions (`activationGaps`)
 * that a create form cannot satisfy on its own, because the parties are
 * added afterwards. A lease that came into being already live would be a
 * lease nobody checked.
 */
export async function createLease(
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const unitId = str(formData, 'unitId')
  const unit = unitId
    ? await prisma.unit.findUnique({
        where: { id: unitId },
        include: { property: { select: { id: true, legalEntityId: true } } },
      })
    : null
  if (!unit) {
    return { error: 'Choose the unit.', fieldErrors: { unitId: 'Choose the unit.' } }
  }
  await requirePermission('lease.write', propertyResource(unit.property))

  const isMonthToMonth = formData.get('isMonthToMonth') === 'yes'
  const origin = str(formData, 'origin') === 'INHERITED' ? 'INHERITED' : 'APPLICATION'

  const input = {
    unitId,
    startsOn: str(formData, 'startsOn'),
    endsOn: str(formData, 'endsOn') || null,
    rentDollars: str(formData, 'rentDollars'),
    depositDollars: str(formData, 'depositDollars') || null,
    nsfFeeDollars: str(formData, 'nsfFeeDollars') || null,
    depositArrangement: str(formData, 'depositArrangement') || 'CASH',
    requireFullBalance: formData.get('requireFullBalance') === 'on',
    rentDueDay: str(formData, 'rentDueDay') || '1',
    isMonthToMonth,
    mtmRentDollars: str(formData, 'mtmRentDollars') || null,
  }
  const violations = [
    ...validateLease(input),
    ...(await depositCapViolations(unit.propertyId, input)),
  ]
  if (violations.length > 0) return violationsToState(violations)

  // An inherited tenancy's deposit position starts as UNKNOWN, never as the
  // NOT_APPLICABLE default - see LeaseOrigin's own schema comment. That
  // single assignment is what puts it on the outstanding-items list instead
  // of letting it sit looking settled.
  const depositTransferStatus = origin === 'INHERITED' ? 'UNKNOWN' : 'NOT_APPLICABLE'

  const lease = await prisma.$transaction(async (tx) => {
    const created = await tx.lease.create({
      data: {
        propertyId: unit.propertyId,
        unitId,
        status: 'DRAFT',
        origin,
        depositTransferStatus,
        startsOn: parseLeaseDate(input.startsOn)!,
        endsOn: input.endsOn ? parseLeaseDate(input.endsOn) : null,
        rentCents: leaseCents(input.rentDollars)!,
        depositCents: leaseCents(input.depositDollars) ?? 0,
        // NOT `?? 0`, unlike the deposit. Blank means the lease is silent,
        // which means no fee at all - and `0` would mean a lease that
        // expressly charges nothing, which is a different sentence and one
        // no landlord has written here. See Lease.nsfFeeCents (R-039a).
        nsfFeeCents: leaseCents(input.nsfFeeDollars),
        depositArrangement: input.depositArrangement as 'CASH' | 'SURETY_BOND' | 'NONE',
        requireFullBalance: input.requireFullBalance,
        rentDueDay: Number(input.rentDueDay),
        isMonthToMonth,
        mtmRentCents: leaseCents(input.mtmRentDollars),
        utilityResponsibility: readUtilities(formData),
      },
    })
    await audit(
      {
        action: 'lease.created',
        entityType: 'Lease',
        entityId: created.id,
        propertyId: unit.propertyId,
        after: {
          origin,
          unitId,
          startsOn: created.startsOn.toISOString(),
          endsOn: created.endsOn?.toISOString() ?? null,
          rentCents: created.rentCents,
          depositCents: created.depositCents,
          depositTransferStatus,
        },
      },
      tx,
    )
    return created
  })

  // Outside the transaction: the lease exists whether or not the prompts
  // land, and a failed Task write must not roll back the record itself.
  if (origin === 'INHERITED') {
    await raiseIntakeTasks(lease.id).catch((error) => {
      console.error(`[lease] intake tasks failed for ${lease.id}`, error)
    })
  }

  revalidatePath('/leases')
  redirect(`/leases/${lease.id}`)
}

/// LEASE-06's utility responsibility matrix, read off the form. Stored as
/// JSON because the shape is a lease-template concern (R-063) and
/// normalizing it before there is a template to normalize against would be
/// guessing at the schema.
function readUtilities(formData: FormData): Record<string, string> {
  const matrix: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('utility.') && typeof value === 'string' && value) {
      matrix[key.slice('utility.'.length)] = value
    }
  }
  return matrix
}

/**
 * The statutory deposit cap, checked where the jurisdiction rule can be read
 * (R-041, PAY-07; D-4).
 *
 * Separate from `validateLease`, which is pure and has no property to look a
 * rule up for. Checked at the point somebody TYPES the amount, not at
 * move-out: an over-collected deposit is a violation on the day it is taken,
 * and in several states the remedy runs to multiples of the excess, so
 * finding out two years later - when the tenant's lawyer does - is the
 * expensive way round.
 *
 * An unconfigured state yields no cap and therefore no violation, exactly as
 * late fees and NSF fees treat it: D-4's point is that a statutory number
 * comes from configuration, and inventing one for a market nobody has set up
 * is how a product enforces a rule that does not exist.
 */
async function depositCapViolations(
  propertyId: string,
  input: { depositDollars?: string | null; rentDollars: string; depositArrangement?: string | null },
): Promise<{ field: string; message: string }[]> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { state: true, county: true },
  })
  if (!property) return []

  const rule = await rulesFor(
    { state: property.state, county: property.county },
    new Date(),
  ).catch(() => null)
  if (!rule) return []

  return validateDepositAmount({
    depositCents: leaseCents(input.depositDollars) ?? 0,
    rentCents: leaseCents(input.rentDollars) ?? 0,
    arrangement: (input.depositArrangement ?? 'CASH') as 'CASH' | 'SURETY_BOND' | 'NONE',
    rule,
  })
}

export async function updateLeaseTerms(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)

  const isMonthToMonth = formData.get('isMonthToMonth') === 'yes'
  const input = {
    unitId: lease.unitId,
    startsOn: str(formData, 'startsOn'),
    endsOn: str(formData, 'endsOn') || null,
    rentDollars: str(formData, 'rentDollars'),
    depositDollars: str(formData, 'depositDollars') || null,
    nsfFeeDollars: str(formData, 'nsfFeeDollars') || null,
    depositArrangement: str(formData, 'depositArrangement') || 'CASH',
    requireFullBalance: formData.get('requireFullBalance') === 'on',
    rentDueDay: str(formData, 'rentDueDay') || '1',
    isMonthToMonth,
    mtmRentDollars: str(formData, 'mtmRentDollars') || null,
  }
  const retaliationReason = str(formData, 'retaliationReason') || null
  const violations = [
    ...validateLease(input),
    ...(await depositCapViolations(lease.propertyId, input)),
  ]
  if (violations.length > 0) return violationsToState(violations)

  const before = {
    startsOn: lease.startsOn.toISOString(),
    endsOn: lease.endsOn?.toISOString() ?? null,
    rentCents: lease.rentCents,
    depositCents: lease.depositCents,
    nsfFeeCents: lease.nsfFeeCents,
    depositArrangement: lease.depositArrangement,
    requireFullBalance: lease.requireFullBalance,
    rentDueDay: lease.rentDueDay,
    isMonthToMonth: lease.isMonthToMonth,
    mtmRentCents: lease.mtmRentCents,
  }
  const after = {
    startsOn: parseLeaseDate(input.startsOn)!,
    endsOn: input.endsOn ? parseLeaseDate(input.endsOn) : null,
    rentCents: leaseCents(input.rentDollars)!,
    depositCents: leaseCents(input.depositDollars) ?? 0,
    nsfFeeCents: leaseCents(input.nsfFeeDollars),
    depositArrangement: input.depositArrangement as 'CASH' | 'SURETY_BOND' | 'NONE',
    requireFullBalance: input.requireFullBalance,
    rentDueDay: Number(input.rentDueDay),
    isMonthToMonth,
    mtmRentCents: leaseCents(input.mtmRentDollars),
  }

  // RISK-06 (R-055): a RAISE, not any rent change - a correction or a
  // decrease is not the adverse action the guard exists to catch, and
  // warning on one would train staff to click through it on every edit.
  let retaliation: Awaited<ReturnType<typeof retaliationCheckFor>> = null
  if (after.rentCents > before.rentCents) {
    const now = new Date()
    retaliation = await retaliationCheckFor({
      leaseId,
      propertyState: lease.property.state,
      propertyCounty: lease.property.county,
      actionDate: now,
    })
    if (retaliation) {
      const ackViolations = validateRetaliationAck(retaliationReason)
      if (ackViolations.length > 0) {
        // NOTHING is written - same posture as R-027's entry-notice
        // override. Saving the raise and asking for the reason afterwards
        // would leave an unexplained retaliatory-looking increase on the
        // record if the second step never happened.
        return {
          error: `This rent increase is ${retaliation.daysAgo} days after this tenant's ${retaliation.category} complaint, inside the ${retaliation.windowDays}-day retaliation-presumption window for ${lease.property.state}.`,
          fieldErrors: Object.fromEntries(ackViolations.map((v) => [v.field, v.message])),
          needsRetaliationAck: retaliationAckView(retaliation, lease.property.timezone),
          values: {
            startsOn: input.startsOn,
            endsOn: input.endsOn ?? '',
            rentDollars: input.rentDollars,
            depositDollars: input.depositDollars ?? '',
            nsfFeeDollars: input.nsfFeeDollars ?? '',
            depositArrangement: input.depositArrangement,
            rentDueDay: input.rentDueDay,
            mtmRentDollars: input.mtmRentDollars ?? '',
          },
        }
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: { ...after, utilityResponsibility: readUtilities(formData) },
    })
    await audit(
      {
        action: 'lease.updated',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before,
        after: {
          ...after,
          startsOn: after.startsOn.toISOString(),
          endsOn: after.endsOn?.toISOString() ?? null,
        },
      },
      tx,
    )
    if (retaliation) {
      await audit(
        {
          action: 'lease.retaliation_window_acknowledged',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: {
            trigger: 'rent_increase',
            fromCents: before.rentCents,
            toCents: after.rentCents,
            complaintTicketId: retaliation.ticketId,
            complaintOccurredAt: retaliation.occurredAt.toISOString(),
            daysAgo: retaliation.daysAgo,
            windowDays: retaliation.windowDays,
          },
          reasonCode: 'owner_directive',
          reason: retaliationReason!,
        },
        tx,
      )
    }
  })

  // A rent change has to reach Stripe, or the tenant keeps being billed the
  // old amount indefinitely (D-11, R-036). Only when it actually moved -
  // an edit that did not touch the rent should not burn an API round trip.
  if (after.rentCents !== before.rentCents) {
    await syncLease(leaseId).catch((error) => {
      console.error(`[lease] billing sync failed after a rent change on ${leaseId}`, error)
    })
  }

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Saved.' }
}

/**
 * Moves the lease through its lifecycle.
 *
 * The unit's own status is coupled here rather than left to a nightly job:
 * activating a lease occupies the unit NOW, and recording a move-out frees
 * it NOW. R-009's `unit.auto_make_ready` remains the backstop for the case
 * nobody touches - a fixed term that simply runs out - and its own comment
 * already names this item as the process that would take over.
 */
export async function changeLeaseStatus(
  leaseId: string,
  to: LeaseStatusValue,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease, actor } = await leaseForWrite(leaseId)
  const reason = str(formData, 'reason') || null

  const decision = leaseTransition(
    {
      status: lease.status,
      tenantCount: lease.leaseTenants.length,
      rentCents: lease.rentCents,
      startsOn: lease.startsOn,
      endsOn: lease.endsOn,
      isMonthToMonth: lease.isMonthToMonth,
    },
    to,
    reason,
  )
  if (!decision.allowed) return { error: decision.message }

  // A lease sent for e-signature (R-063) must not be short-circuited to
  // ACTIVE by the generic status button while a signer could still be
  // partway through - that is what `esign-actions.ts`'s own completion path
  // is for, and it does not run here. Void the envelope first
  // (`voidEnvelope`, /leases/[id]) if the intent is really to skip signing.
  if (lease.status === 'PENDING_SIGNATURE' && to === 'ACTIVE') {
    const liveEnvelope = await prisma.leaseEnvelope.findFirst({
      // R-090: LEASE only. An amendment out for signature is not a reason
      // to refuse a lease activation - and cannot co-occur with one anyway,
      // since a change of parties requires an in-force tenancy.
      where: { leaseId, kind: 'LEASE', status: { in: ['SENT', 'PARTIALLY_SIGNED'] } },
      select: { id: true },
    })
    if (liveEnvelope) {
      return {
        error:
          'This lease is out for signature. Void the envelope before activating it any other way.',
      }
    }
  }

  const now = new Date()
  const wasInForce = leaseIsInForce(lease.status)
  const willBeInForce = leaseIsInForce(to)

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: {
        status: to,
        ...(to === 'ACTIVE' && !lease.activatedAt ? { activatedAt: now } : {}),
        ...(to === 'TERMINATED' ? { terminationReason: reason } : {}),
        // Recorded on the way out, and only if nobody recorded it already -
        // a PM who logged the actual move-out date should not have it
        // overwritten by the moment they clicked the button.
        ...((to === 'ENDED' || to === 'TERMINATED') && !lease.moveOutAt
          ? { moveOutAt: now }
          : {}),
      },
    })

    if (!wasInForce && willBeInForce) {
      // Going live occupies the unit and delists any published listing
      // (R-057, LEASE-02, D-7: "≤24h delist on lease-up") - shared with the
      // esign completion path in esign-actions.ts, see activate.ts's own
      // header for why it is one function rather than two copies.
      await activateLeaseSideEffects(tx, lease)
    }
    if (wasInForce && !willBeInForce) {
      // Coming off. Guarded on OCCUPIED so a unit somebody has already
      // marked DOWN for a renovation is not quietly reclassified as ready
      // to turn.
      await tx.unit.updateMany({
        where: { id: lease.unitId, status: 'OCCUPIED' },
        data: { status: 'MAKE_READY' },
      })
    }

    await audit(
      {
        // TERMINATED gets its own action so `recordAudit` itself refuses a
        // termination with no reason - see REASON_REQUIRED.
        action: to === 'TERMINATED' ? 'lease.terminated' : 'lease.status_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before: { status: lease.status },
        after: { status: to, byStaffId: actor.id },
        ...(to === 'TERMINATED' ? { reason: reason ?? undefined } : {}),
      },
      tx,
    )
  })

  // Billing follows the tenancy (D-11, R-034 provisions, R-036 syncs).
  // AFTER the commit and never allowed to fail this action: a status change
  // is a tenancy fact, and a billing provider being unreachable must not
  // undo it. Both calls are idempotent and record their own failures, so
  // re-running the transition - or the nightly sweep - is how billing
  // catches up.
  if (!wasInForce && willBeInForce) {
    await provisionLeaseBilling(leaseId).catch((error) => {
      console.error(`[lease] billing provisioning failed for ${leaseId}`, error)
    })
  } else if (wasInForce && !willBeInForce) {
    // The tenancy ended. `syncLease` reads what Stripe currently believes
    // and cancels - effective at the move-out date where there is one, so a
    // tenancy ending on the last day of a month still bills that month.
    await syncLease(leaseId).catch((error) => {
      console.error(`[lease] billing sync failed for ${leaseId}`, error)
    })
    // The statutory disposition countdown starts from THIS move-out (R-071,
    // INSP-03) - a no-op for a zero-deposit lease or one already started.
    await startDepositDisposition(leaseId).catch((error) => {
      console.error(`[lease] deposit disposition start failed for ${leaseId}`, error)
    })
    // The turnover / make-ready project starts from the same move-out
    // (LEASE-12, R-072) - idempotent, so a status change re-run is a no-op.
    await startTurnoverProjectForLease(leaseId).catch((error) => {
      console.error(`[lease] turnover project start failed for ${leaseId}`, error)
    })
    // R-094b. THE DOOR STOPS WORKING WHEN THE TENANCY DOES. Every other
    // consequence of a tenancy ending here is about money or scheduling and
    // can be caught up by a re-run; this one is about whether a former
    // occupant can still walk in, so it happens on the transition rather
    // than waiting for anybody to remember. Best-effort like its siblings: a
    // lock being offline must not undo a tenancy ending, and the row records
    // that the device may not agree.
    await revokeTenantLockCodes(
      { leaseId },
      { reason: 'The tenancy ended.', staffId: null },
    )
      .then(async (revoked) => {
        if (revoked.length === 0) return
        await audit({
          action: 'accesscode.tenant_code_revoked',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          reason: 'The tenancy ended.',
          after: {
            codeIds: revoked.map((code) => code.id),
            tenantIds: revoked.map((code) => code.tenantId),
            reachedDevice: revoked.every((code) => code.reachedDevice),
          },
        })
      })
      .catch((error) => {
        console.error(`[lease] tenant lock code revoke failed for ${leaseId}`, error)
      })
  }

  revalidatePath(`/leases/${leaseId}`)
  revalidatePath('/leases')
  return { notice: 'Saved.' }
}

/**
 * Records notice to end the tenancy (LEASE-11, RISK-06, R-062's clock, R-066).
 *
 * Does NOT change the status. A tenancy under notice is still running -
 * rent is still due, repairs are still owed - and modelling notice as a
 * state would mean every "is this lease in force?" check had to remember to
 * include it. See LeaseStatus's own schema comment.
 *
 * A LANDLORD notice is a real outbound legal document - it generates and
 * serves a `Notice` (type NON_RENEWAL) the same way `scheduleEntry()`
 * serves an entry notice, with delivery logging and a notification to the
 * tenant. A TENANT'S OWN notice to vacate is the opposite: an inbound fact
 * we record, never something served, so no Notice row exists for it.
 *
 * Two independent warn-and-override checks can fire on the SAME notice -
 * the jurisdiction's notice-period (either party can give short notice) and
 * RISK-06's retaliation guard (landlord notices only) - and both are
 * checked and returned together rather than one at a time, so staff never
 * clears one warning only to be handed a second on the next submit.
 */
export async function recordLeaseNotice(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease, actor } = await leaseForWrite(leaseId)

  const by = str(formData, 'noticeGivenBy')
  if (by !== 'TENANT' && by !== 'LANDLORD') {
    return {
      error: 'Say who gave notice.',
      fieldErrors: { noticeGivenBy: 'Tenant or landlord?' },
    }
  }
  const givenOnRaw = str(formData, 'givenOn')
  const givenOn = givenOnRaw ? parseLeaseDate(givenOnRaw) : new Date()
  if (!givenOn) {
    return { error: 'That date could not be read.', fieldErrors: { givenOn: 'Check the date.' } }
  }
  const effectiveOnRaw = str(formData, 'effectiveOn')
  const effectiveOn = parseLeaseDate(effectiveOnRaw)
  if (!effectiveOn) {
    return {
      error: 'Say when the tenancy will actually end.',
      fieldErrors: { effectiveOn: 'Check the date.' },
    }
  }
  const forwardingAddress = str(formData, 'forwardingAddress') || null
  const justCauseStatement = str(formData, 'justCauseStatement') || null
  const noticePeriodReason = str(formData, 'noticePeriodReason') || null
  const retaliationReason = str(formData, 'retaliationReason') || null
  const values = {
    noticeGivenBy: by,
    givenOn: givenOnRaw,
    effectiveOn: effectiveOnRaw,
    forwardingAddress: forwardingAddress ?? '',
    justCauseStatement: justCauseStatement ?? '',
  }

  const decision = canGiveNotice({ status: lease.status, noticeGivenAt: lease.noticeGivenAt })
  if (!decision.allowed) return { error: decision.message }

  const rule = await rulesFor(
    { state: lease.property.state, county: lease.property.county },
    givenOn,
  ).catch(() => null)

  // PRD §7's "just-cause jurisdiction flag" - required BEFORE either warning
  // below, because it is not conditional on timing the way they are: a
  // jurisdiction that requires a stated cause requires one on every
  // non-renewal, not only a hastily-timed one. Never a canned list of
  // causes this product picks - see validateJustCauseStatement's own header.
  const justCauseViolations = validateJustCauseStatement(
    by === 'LANDLORD' && Boolean(rule?.justCauseRequired),
    justCauseStatement,
  )
  if (justCauseViolations.length > 0) {
    return {
      error: 'This jurisdiction requires a stated cause for non-renewal.',
      fieldErrors: Object.fromEntries(justCauseViolations.map((v) => [v.field, v.message])),
      values,
    }
  }

  const noticePeriod = noticePeriodCheck({
    givenOn,
    effectiveOn,
    noticeToVacateDays: rule?.noticeToVacateDays ?? null,
  })
  if (noticePeriod.needsOverride) {
    const violations = validateNoticePeriodOverride(noticePeriodReason)
    if (violations.length > 0) {
      return {
        error: `This is ${noticePeriod.shortfallDays} day${noticePeriod.shortfallDays === 1 ? '' : 's'} short of the ${noticePeriod.requiredDays}-day notice period for ${lease.property.state}.`,
        fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
        needsNoticePeriodAck: {
          daysGiven: noticePeriod.daysGiven,
          requiredDays: noticePeriod.requiredDays!,
          shortfallDays: noticePeriod.shortfallDays!,
        },
        values,
      }
    }
  }

  // RISK-06 (R-055): only when WE gave notice. A tenant ending their own
  // tenancy is not an adverse action anybody could call retaliation.
  let retaliation: Awaited<ReturnType<typeof retaliationCheckFor>> = null
  if (by === 'LANDLORD') {
    retaliation = await retaliationCheckFor({
      leaseId,
      propertyState: lease.property.state,
      propertyCounty: lease.property.county,
      actionDate: givenOn,
    })
    if (retaliation) {
      const ackViolations = validateRetaliationAck(retaliationReason)
      if (ackViolations.length > 0) {
        return {
          error: `This notice is ${retaliation.daysAgo} days after this tenant's ${retaliation.category} complaint, inside the ${retaliation.windowDays}-day retaliation-presumption window for ${lease.property.state}.`,
          fieldErrors: Object.fromEntries(ackViolations.map((v) => [v.field, v.message])),
          needsRetaliationAck: retaliationAckView(retaliation, lease.property.timezone),
          values,
        }
      }
    }
  }

  // Fetched separately from leaseForWrite's own query, deliberately - that
  // one is shared by every action in this file and its leaseTenants shape
  // (a bare count, used elsewhere) must not silently narrow to primary-only
  // for every OTHER caller just because this one needs a name and an
  // address to write to.
  let noticeId: string | null = null
  const primaryTenant =
    by === 'LANDLORD'
      ? await prisma.leaseTenant.findFirst({
          where: { leaseId, isPrimary: true },
          include: { tenant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
        })
      : null
  const unitName =
    by === 'LANDLORD'
      ? (await prisma.unit.findUnique({ where: { id: lease.unitId }, select: { name: true } }))?.name ?? ''
      : ''

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: leaseId },
      data: {
        noticeGivenAt: givenOn,
        noticeGivenBy: by as NoticePartyValue,
        noticeEffectiveOn: effectiveOn,
        // Never set for a LANDLORD non-renewal - see the schema's own
        // comment on why a forwarding address only ever comes from the
        // tenant.
        noticeForwardingAddress: by === 'TENANT' ? forwardingAddress : null,
      },
    })
    await audit(
      {
        action: 'lease.notice_given',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: {
          noticeGivenAt: givenOn.toISOString(),
          noticeGivenBy: by,
          effectiveOn: effectiveOn.toISOString(),
        },
      },
      tx,
    )

    if (by === 'LANDLORD' && primaryTenant) {
      const notice = await tx.notice.create({
        data: {
          propertyId: lease.propertyId,
          leaseId,
          type: 'NON_RENEWAL',
          addressOfRecord: lease.property.addressLine1,
          bodyText: nonRenewalNoticeText({
            tenantName: `${primaryTenant.tenant.firstName} ${primaryTenant.tenant.lastName}`,
            addressLine1: lease.property.addressLine1,
            unitName,
            timezone: lease.property.timezone,
            effectiveOn,
            justCauseStatement,
            noticeToVacateDays: rule?.noticeToVacateDays ?? null,
          }),
          serviceMethod: 'PORTAL',
          servedAt: givenOn,
          servedByStaffId: actor.id,
          jurisdictionRuleId: rule?.id ?? null,
        },
      })
      noticeId = notice.id
      await tx.noticeDelivery.create({
        data: {
          noticeId: notice.id,
          method: 'PORTAL',
          servedAt: givenOn,
          servedByStaffId: actor.id,
          jurisdictionRuleId: rule?.id ?? null,
        },
      })
      await audit(
        {
          action: 'notice.served',
          entityType: 'Notice',
          entityId: notice.id,
          propertyId: lease.propertyId,
          after: {
            type: 'NON_RENEWAL',
            serviceMethod: 'PORTAL',
            effectiveOn: effectiveOn.toISOString(),
            jurisdictionRuleId: rule?.id ?? null,
          },
        },
        tx,
      )
    }

    if (noticePeriod.needsOverride) {
      await audit(
        {
          action: 'lease.notice_period_overridden',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: {
            noticeGivenBy: by,
            daysGiven: noticePeriod.daysGiven,
            requiredDays: noticePeriod.requiredDays,
            shortfallDays: noticePeriod.shortfallDays,
          },
          reasonCode: 'owner_directive',
          reason: noticePeriodReason!,
        },
        tx,
      )
    }
    if (retaliation) {
      await audit(
        {
          action: 'lease.retaliation_window_acknowledged',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: {
            trigger: 'landlord_notice',
            noticeGivenAt: givenOn.toISOString(),
            complaintTicketId: retaliation.ticketId,
            complaintOccurredAt: retaliation.occurredAt.toISOString(),
            daysAgo: retaliation.daysAgo,
            windowDays: retaliation.windowDays,
          },
          reasonCode: 'owner_directive',
          reason: retaliationReason!,
        },
        tx,
      )
    }
  })

  // Tell the tenant, outside the transaction - notify() decides and
  // records, dispatch sends, neither belongs inside a transaction holding
  // row locks (R-016's rule, same as scheduleEntry's own identical call).
  if (noticeId && primaryTenant) {
    try {
      const outcomes = await notify({
        category: 'legal_notice',
        templateKey: 'lease.non_renewal',
        recipient: {
          type: 'TENANT',
          id: primaryTenant.tenant.id,
          email: primaryTenant.tenant.email,
          phone: primaryTenant.tenant.phone,
        },
        context: {
          tenantName: primaryTenant.tenant.firstName,
          addressLine1: lease.property.addressLine1,
          effectiveOn: businessDate(effectiveOn, lease.property.timezone),
          url: authUrl(`/portal/notices/${noticeId}`),
        },
        propertyId: lease.propertyId,
        idempotencyKey: `non-renewal:${noticeId}`,
      })
      await dispatchPendingNotifications(new Date(), 100, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[leases] failed to notify tenant of non-renewal for ${leaseId}`, error)
    }
  }

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Notice recorded.' }
}

export async function addLeaseTenant(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)
  const tenantId = str(formData, 'tenantId')
  if (!tenantId) return { error: 'Choose who is on the lease.' }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) return { error: 'That person could not be found.' }

  const existing = await prisma.leaseTenant.count({ where: { leaseId } })

  try {
    await prisma.$transaction(async (tx) => {
      await tx.leaseTenant.create({
        data: {
          leaseId,
          tenantId,
          // The first person on a lease is the primary by default. Somebody
          // has to be the one a single-recipient message goes to, and
          // leaving every lease with no primary would make that a decision
          // taken at send time by whatever sorted first.
          isPrimary: existing === 0,
        },
      })
      await audit(
        {
          action: 'lease.party_changed',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: { added: 'tenant', tenantId, isPrimary: existing === 0 },
        },
        tx,
      )
    })
  } catch {
    // The unique (leaseId, tenantId) is the guard. Adding somebody twice is
    // a double-click, not an error worth a red banner.
    return { notice: 'They are already on this lease.' }
  }

  revalidatePath(`/leases/${leaseId}`)
  return {}
}

export async function removeLeaseTenant(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)
  const leaseTenantId = str(formData, 'leaseTenantId')

  const row = await prisma.leaseTenant.findUnique({ where: { id: leaseTenantId } })
  if (!row || row.leaseId !== leaseId) return { error: 'That person is not on this lease.' }

  // NOT A PATH OFF A LIVE TENANCY, AND NOW IT SAYS SO (R-090). This is the
  // draft-lease editing tool - somebody typed in the wrong person before the
  // lease was ever signed - and it HARD DELETES the row.
  //
  // Until R-090 it refused only when the removal would empty the tenancy,
  // which meant a roommate could be taken off a running, signed lease with
  // one click and no record beyond an audit line: no release, no signature
  // from the people who stay, no document saying what they were and were not
  // released from, and nothing at all told to the person leaving. This
  // comment already pointed at "RISK-10's roommate-change flow"; that flow
  // now exists, so this refuses and sends the operator to it.
  if (leaseIsInForce(lease.status)) {
    return {
      error:
        'This lease is running. Taking somebody off a live tenancy is a change of occupants — start one below, so everybody signs the amendment.',
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.leaseTenant.delete({ where: { id: leaseTenantId } })
    await audit(
      {
        action: 'lease.party_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        before: { tenantId: row.tenantId, isPrimary: row.isPrimary },
        after: { removed: 'tenant', tenantId: row.tenantId },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return {}
}

/**
 * Adds a guarantor (LEASE-06: "a distinct role: screened, financially
 * liable on the ledger, no portal access to maintenance/comms").
 *
 * The "no portal access" half needs no enforcement here and deliberately
 * has none: a Guarantor is its own model, is not a Tenant, and the portal
 * authenticates Tenants. There is no flag anybody could set wrong.
 */
export async function addGuarantor(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)

  const input = {
    firstName: str(formData, 'firstName'),
    lastName: str(formData, 'lastName'),
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone') || null,
  }
  const violations = validateGuarantor(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.$transaction(async (tx) => {
    const guarantor = await tx.guarantor.create({ data: { leaseId, ...input } })
    await audit(
      {
        action: 'lease.party_changed',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: { added: 'guarantor', guarantorId: guarantor.id, name: `${input.firstName} ${input.lastName}` },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return {}
}

/**
 * Resolves one of an inherited tenancy's outstanding items (RISK-08).
 *
 * Both facts are assertions somebody made on a date, which is why each
 * writes an audit entry rather than only a column: at move-out, "when did
 * you establish that the deposit never transferred?" is a question a
 * dispute turns on.
 */
export async function resolveIntakeItem(
  leaseId: string,
  _previous: LeaseFormState,
  formData: FormData,
): Promise<LeaseFormState> {
  const { lease } = await leaseForWrite(leaseId)
  const item = str(formData, 'item')

  if (item === 'estoppel') {
    if (lease.estoppelConfirmedAt) return { notice: 'Already confirmed.' }
    const at = new Date()
    await prisma.$transaction(async (tx) => {
      await tx.lease.update({ where: { id: leaseId }, data: { estoppelConfirmedAt: at } })
      await audit(
        {
          action: 'lease.intake_resolved',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          after: { item: 'estoppel', confirmedAt: at.toISOString() },
        },
        tx,
      )
    })
  } else if (item === 'deposit_transfer') {
    const status = str(formData, 'depositTransferStatus')
    if (status !== 'TRANSFERRED' && status !== 'NOT_TRANSFERRED') {
      return {
        error: 'Say what happened to the deposit.',
        fieldErrors: { depositTransferStatus: 'Transferred, or kept by the seller?' },
      }
    }
    const note = str(formData, 'depositTransferNote') || null
    await prisma.$transaction(async (tx) => {
      await tx.lease.update({
        where: { id: leaseId },
        data: { depositTransferStatus: status, depositTransferNote: note },
      })
      await audit(
        {
          action: 'lease.intake_resolved',
          entityType: 'Lease',
          entityId: leaseId,
          propertyId: lease.propertyId,
          before: { depositTransferStatus: lease.depositTransferStatus },
          after: { item: 'deposit_transfer', depositTransferStatus: status, note },
        },
        tx,
      )
    })
  } else {
    // condition_baseline is resolved by uploading a document, not by a
    // button - see the lease page's own upload form.
    return { error: 'That item is not resolved from here.' }
  }

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Recorded.' }
}
