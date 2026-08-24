'use server'

import { entryDecision, entryNoticeText } from '@rental/core/entry'
import { businessDate, friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { issueToken, redeemToken } from '@/lib/auth/store.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { createTask } from '@/lib/tasks/create.ts'
import { availableSlotsFor } from './queries.ts'
import { showingLinkStatus } from './link.ts'

// PUBLIC writes for Showing (LEASE-08, R-064) - no session, same posture as
// prospects/actions.ts and prospects/prescreen-actions.ts.
//
// DELIBERATELY SEPARATE from staff-actions.ts, which needs `audit()`
// (session-resolved, transitively imports Auth.js) - see those two files'
// own headers for the wall this split works around. This file must stay
// import-clean of lib/audit/index.ts.

export interface BookingFormState {
  error?: string
  notice?: string
  booked?: { scheduledStart: string; scheduledEnd: string }
}

const LINK_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  already_used: 'This link has already been used - you already booked a showing.',
  expired: 'This link has expired. Reply to the message you received and we’ll send a new one.',
}

/**
 * A prospect books their own showing slot (LEASE-08's "self-serve slot
 * booking").
 *
 * The submitted slot is re-validated against a FRESH `availableSlotsFor()`
 * call rather than trusted from the form - the same reason
 * `submitPrescreenAnswers` re-checks its token: the list rendered on the
 * page can go stale (another prospect takes the slot, the entry-notice
 * window shifts) in the gap between render and submit.
 *
 * Occupied units generate and serve the required entry notice inline, using
 * R-027's own `entryDecision()`/`entryNoticeText()` - the exact machinery
 * `scheduleEntry()` uses for a work order, applied here to a showing. There
 * is no warn-and-override here, unlike that staff-facing form: a self-serve
 * booking has nobody present to give a reason, so a slot that fails the
 * check is simply refused rather than booked-with-a-warning.
 */
export async function bookShowing(
  rawToken: string,
  _previous: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const link = await showingLinkStatus(rawToken)
  if (!link.ok) {
    return { error: LINK_ERROR_MESSAGES[link.reason] ?? 'This link is not valid.' }
  }

  const raw = formData.get('slot')
  const requested = typeof raw === 'string' ? new Date(raw) : null
  if (!requested || Number.isNaN(requested.getTime())) {
    return { error: 'Choose a time.' }
  }

  const now = new Date()
  const unit = { id: link.unitId, status: link.unitStatus }
  const property = { state: link.state, county: link.county, timezone: link.timezone }
  const slots = await availableSlotsFor(unit, property, now)
  if (!slots.some((s) => s.getTime() === requested.getTime())) {
    return { error: 'That time is no longer available. Pick another.' }
  }
  const scheduledEnd = new Date(requested.getTime() + 30 * 60_000)

  let entryNoticeId: string | null = null
  if (link.unitStatus === 'OCCUPIED') {
    const lease = await prisma.lease.findFirst({
      where: { unitId: link.unitId, status: 'ACTIVE' },
      include: { leaseTenants: { where: { isPrimary: true }, include: { tenant: true } } },
    })
    const tenant = lease?.leaseTenants[0]?.tenant
    if (!lease || !tenant) {
      // Unit.status says OCCUPIED but there is no active lease/tenant to
      // notify - a data inconsistency this action cannot lawfully paper
      // over by booking anyway. Refused rather than booked-without-notice.
      return { error: 'This unit is not available for self-serve booking right now. Contact us.' }
    }

    const rule = await rulesFor({ state: link.state, county: link.county }, now)
    const decision = entryDecision({
      scheduledStart: requested,
      noticeServedAt: now,
      entryNoticeHours: rule.entryNoticeHours,
      isEmergency: false,
      tenantPermissionGrantedAt: null,
    })
    if (!decision.permitted) {
      // Would only happen if a rule tightened between the slot list being
      // computed (which already excludes anything short of
      // earliestCompliantStart) and this submit - the same staleness
      // `slots.some(...)` above guards, belt and braces.
      return { error: 'That time is no longer available. Pick another.' }
    }

    const notice = await prisma.notice.create({
      data: {
        propertyId: link.propertyId,
        leaseId: lease.id,
        type: 'ENTRY_NOTICE',
        addressOfRecord: link.addressLine1,
        bodyText: entryNoticeText({
          tenantName: `${tenant.firstName} ${tenant.lastName}`,
          addressLine1: link.addressLine1,
          unitName: link.unitName,
          scheduledStart: requested,
          scheduledEnd,
          reason: 'A showing for a prospective tenant',
          timezone: link.timezone,
          entryNoticeHours: rule.entryNoticeHours,
        }),
        serviceMethod: 'PORTAL',
        servedAt: now,
        jurisdictionRuleId: rule.id,
      },
    })
    entryNoticeId = notice.id
    await prisma.noticeDelivery.create({
      data: { noticeId: notice.id, method: 'PORTAL', servedAt: now, jurisdictionRuleId: rule.id },
    })
    await auditAsSystem(`showing-booking:${link.prospectId}`, {
      action: 'notice.served',
      entityType: 'Notice',
      entityId: notice.id,
      propertyId: link.propertyId,
      after: {
        type: 'ENTRY_NOTICE',
        serviceMethod: 'PORTAL',
        scheduledStart: requested.toISOString(),
        entryNoticeHours: rule.entryNoticeHours,
        jurisdictionRuleId: rule.id,
      },
    })

    try {
      const outcomes = await notify({
        category: 'entry_notice',
        templateKey: 'entry.notice',
        recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
        context: {
          tenantName: tenant.firstName,
          addressLine1: link.addressLine1,
          unitName: link.unitName,
          scheduledStart: requested.toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          timezone: link.timezone,
          reason: 'A showing for a prospective tenant',
        },
        propertyId: link.propertyId,
        idempotencyKey: `showing-entry-notice:${notice.id}`,
      })
      await dispatchPendingNotifications(now, 100, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[showings] failed to notify tenant for notice ${notice.id}`, error)
    }
  }

  // Read BEFORE the booking transaction so the escort Task and the
  // confirmation message agree about which kind of showing this is.
  const smartLock =
    link.unitStatus === 'VACANT'
      ? await prisma.smartLock.findUnique({
          where: { unitId: link.unitId },
          select: { id: true, active: true },
        })
      : null
  const selfService = smartLock?.active === true

  const redeemed = await redeemToken(rawToken, {
    purpose: 'SHOWING_BOOKING',
    subjectType: 'Prospect',
  })
  if (!redeemed.ok) {
    return { error: 'This link has already been used or has expired.' }
  }

  const showing = await prisma.$transaction(async (tx) => {
    const created = await tx.showing.create({
      data: {
        propertyId: link.propertyId,
        unitId: link.unitId,
        prospectId: link.prospectId,
        scheduledStart: requested,
        scheduledEnd,
        entryNoticeId,
      },
    })
    await tx.prospect.update({ where: { id: link.prospectId }, data: { status: 'SHOWING' } })
    await auditAsSystem(
      `showing-booking:${link.prospectId}`,
      {
        action: 'showing.booked',
        entityType: 'Showing',
        entityId: created.id,
        propertyId: link.propertyId,
        after: { scheduledStart: requested.toISOString(), occupied: link.unitStatus === 'OCCUPIED' },
      },
      tx,
    )
    // R-094: SELF-SERVE ONLY WHERE A LOCK IS FITTED AND THE UNIT IS EMPTY.
    // Everything else books exactly as R-064 booked it - escorted, with a
    // staff Task - so a unit nobody has fitted a lock to is untouched by
    // this feature existing.
    //
    // The occupied case is not a missing feature. LEASE-08 offers
    // self-showings for VACANT units and escorted showings for occupied
    // ones, and an unaccompanied code on an occupied home is a stranger
    // with a key to somebody's house.
    if (!selfService) {
      // Idempotent create-or-return, keyed on the Showing itself, so a
      // retried form submission cannot raise two escort tasks for one
      // booking.
      await createTask(tx, {
        propertyId: link.propertyId,
        type: 'escort_showing',
        subjectType: 'Showing',
        subjectId: created.id,
        businessDate: businessDate(requested, link.timezone),
        priority: 'ROUTINE',
        title: `Escort showing for ${link.unitName} at ${friendlyTimestamp(requested, link.timezone)}`,
      })
    }
    return created
  })

  const prospect = await prisma.prospect.findUniqueOrThrow({ where: { id: link.prospectId } })
  try {
    const outcomes = await notify({
      category: 'prospect_showing',
      templateKey: 'showing.scheduled',
      recipient: {
        type: 'PROSPECT',
        id: link.prospectId,
        email: prospect.email,
        phone: prospect.phone,
      },
      context: {
        firstName: link.firstName,
        addressLine1: link.addressLine1,
        unitName: link.unitName,
        scheduledStart: requested.toISOString(),
        scheduledEnd: scheduledEnd.toISOString(),
        timezone: link.timezone,
        // Without this the confirmation ends "a member of our team will meet
        // you there", which was true of every showing R-064 could book and
        // is a promise nobody is going to keep here.
        selfService,
      },
      propertyId: link.propertyId,
      idempotencyKey: `showing-confirmed:${showing.id}`,
    })
    await dispatchPendingNotifications(now, 100, {
      deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
    })
  } catch (error) {
    console.error(`[showings] failed to send booking confirmation for ${showing.id}`, error)
  }

  // R-094: the link to the door, its own message and its own token. Sent
  // separately from the confirmation on purpose - it is the one a prospect
  // has to find again when they are standing outside, and burying it in a
  // booking confirmation is how it gets scrolled past.
  //
  // BEST-EFFORT, like every other send here. A booking that failed because a
  // provider was down would lose the slot to protect the message.
  if (selfService) {
    try {
      const issued = await issueToken('SHOWING_ACCESS', { type: 'Showing', id: showing.id })
      const outcomes = await notify({
        category: 'prospect_showing',
        templateKey: 'showing.self_access',
        recipient: {
          type: 'PROSPECT',
          id: link.prospectId,
          email: prospect.email,
          phone: prospect.phone,
        },
        context: {
          firstName: link.firstName,
          addressLine1: link.addressLine1,
          unitName: link.unitName,
          scheduledStart: requested.toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          timezone: link.timezone,
          url: authUrl(`/showings/access/${issued.token}`),
        },
        propertyId: link.propertyId,
        idempotencyKey: `showing-access-link:${showing.id}`,
      })
      await dispatchPendingNotifications(now, 100, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[showings] failed to send the access link for ${showing.id}`, error)
    }
  }

  revalidatePath(`/showings/${rawToken}`)
  return { notice: 'Booked.', booked: { scheduledStart: requested.toISOString(), scheduledEnd: scheduledEnd.toISOString() } }
}

/**
 * Mints a single-use SHOWING_BOOKING token and sends the invite. Called from
 * `prospects/prescreen-actions.ts` right after a prospect answers, so
 * booking stays fully self-serve end to end - see that file's own call
 * site. Best-effort like `sendPrescreenInvite`: the Prospect row and its
 * PRE_SCREENED status survive even when this fails.
 */
export async function sendShowingInvite(prospectId: string): Promise<void> {
  const prospect = await prisma.prospect.findUniqueOrThrow({
    where: { id: prospectId },
    include: { property: true },
  })

  const issued = await issueToken('SHOWING_BOOKING', { type: 'Prospect', id: prospect.id })

  await notify({
    category: 'prospect_showing',
    templateKey: 'showing.invite',
    recipient: {
      type: 'PROSPECT',
      id: prospect.id,
      email: prospect.email,
      phone: prospect.phone,
    },
    context: {
      firstName: prospect.firstName,
      addressLine1: prospect.property.addressLine1,
      url: authUrl(`/showings/${issued.token}`),
    },
    propertyId: prospect.propertyId,
    // Idempotent per prospect - a resend deliberately reuses this key so a
    // double-click cannot fan out two invites, matching
    // sendPrescreenInvite's own reasoning.
    idempotencyKey: `prospect-showing-invite:${prospect.id}`,
  })
}
