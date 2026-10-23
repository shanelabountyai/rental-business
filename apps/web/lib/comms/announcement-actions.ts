'use server'

import { businessDate, wallClockToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import { getTemplate, renderForRecipient } from '@/lib/comms/templates.ts'
import { parseSegment } from '@rental/core/comms'
import { previewAnnouncement } from '@/lib/comms/announcement-preview.ts'
import { friendlyWallClock, resolveSegment } from '@/lib/comms/announcements.ts'
import { leasesHalted } from '@/lib/holds/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// Sending a segment announcement (COMM-04, R-053).
//
// Same rules as R-044's bulk chase (apps/web/lib/payments/reminders.ts) for
// everything after the recipient set is decided: a recipient with an
// unfillable merge field is skipped, not sent; the send is idempotent per
// lease per template per property-local day; only this batch's own
// deliveries are dispatched, never the global queue. See announcements.ts
// for why the recipient set itself is a filter here rather than an explicit
// reviewed list.

export interface AnnouncementChannelResult {
  channel: string
  status: string
  reason: string | null
}

export interface AnnouncementRecipientResult {
  leaseId: string
  tenantName: string
  propertyName: string
  channels: AnnouncementChannelResult[]
}

export interface AnnouncementFormState {
  error?: string
  notice?: string
  results?: AnnouncementRecipientResult[]
}

export async function sendAnnouncement(
  _previous: AnnouncementFormState,
  formData: FormData,
): Promise<AnnouncementFormState> {
  // requireScope, not a bare requirePermission - a property-scoped manager
  // holds message.send over their own properties only, and the segment
  // itself is then intersected with that scope below, never trusted alone.
  const { actor, scope } = await requireScope('message.send')

  const templateId = String(formData.get('templateId') ?? '')
  const postedSegment = String(formData.get('segment') ?? '')
  // R-261: empty means now. Otherwise a property-local wall clock, applied in
  // EACH recipient's property timezone - "9am tomorrow" is 9am in Houston and
  // 9am in El Paso, two instants.
  const sendAt = String(formData.get('sendAt') ?? '').trim()
  if (sendAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sendAt)) {
    return { error: 'Pick a date and time to send at, or leave it empty to send now.' }
  }
  // ONE control, not a type plus a conditionally-rendered value (R-115). The
  // second control only existed while client state said so, so before the page
  // hydrated the only segment anybody could actually send to was the default,
  // "All tenants" - the widest one.
  const segment = parseSegment(String(formData.get('segment') ?? ''))

  if (!templateId) return { error: 'Choose a template to send.' }
  if (!segment) {
    return { error: 'Choose who this goes to.' }
  }

  const template = await getTemplate(templateId, actor.orgId)
  if (!template || !template.active) {
    return { error: 'That template is no longer available.' }
  }

  // The same resolution the picker counted with (R-258), so the number the
  // sender saw and the set sent to cannot disagree. Ids come back already
  // intersected with the actor's scope.
  const matched = await resolveSegment(scope, segment)
  // THE REVIEWED LIST IS ON TOP OF THE FILTER, NOT INSTEAD OF IT (R-259).
  // Only ticked tenancies that STILL match are sent to: a posted id outside
  // the segment or the actor's scope is dropped, never trusted, and someone
  // who joined the segment after the review was not reviewed, so is not sent
  // to either (R-044's explicit-list rule).
  const picked = new Set(formData.getAll('leaseIds').map(String))
  const leaseIds = matched.filter((id) => picked.has(id))
  const removed = matched.filter((id) => !picked.has(id))
  if (leaseIds.length === 0) return { error: 'Tick at least one recipient.' }

  // THE PREVIEW'S OWN GATE (R-260, PRD 08 A6): one empty merge field or an
  // over-long body refuses the whole send, naming who - the sender fixes the
  // template or unticks the tenant, rather than learning from the results
  // table that someone was quietly left out. The per-lease skip below stays
  // for a tenancy that changed between this check and the loop.
  const { problems, smsFooter } = await previewAnnouncement(template, leaseIds, actor.orgId)
  if (problems.length > 0) {
    return { error: `Not sent. ${problems.slice(0, 5).join('; ')}.` }
  }

  const leases = await prisma.lease.findMany({
    where: { id: { in: leaseIds } },
    select: {
      id: true,
      propertyId: true,
      property: { select: { name: true, timezone: true } },
      leaseTenants: {
        select: {
          tenant: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              preferredLocale: true,
              active: true,
            },
          },
        },
      },
    },
  })

  if (leases.length === 0) {
    return { error: 'Nobody matches that segment.' }
  }

  const now = new Date()
  const sendAfterByLease = new Map<string, Date>()
  if (sendAt) {
    for (const lease of leases) {
      const at = wallClockToUtc(sendAt, lease.property.timezone)
      if (at.getTime() <= now.getTime()) {
        return {
          error: `${friendlyWallClock(sendAt)} has already passed at ${lease.property.name}. Pick a later time.`,
        }
      }
      if (at.getTime() > now.getTime() + 90 * 24 * 60 * 60 * 1000) {
        return { error: 'Schedule within the next 90 days.' }
      }
      sendAfterByLease.set(lease.id, at)
    }
  }

  const results: AnnouncementRecipientResult[] = []
  const skipped: { leaseId: string; why: string }[] = []
  // Every (row, channel) that got a delivery row, so the final status read
  // back after dispatch can be written into the exact result the UI shows —
  // see the loop below.
  const pending: { row: AnnouncementRecipientResult; channel: string; deliveryId: string }[] = []

  // R-084. Dropped from the AUDIENCE rather than the send being refused: a
  // hydrant-flushing announcement is not worth refusing over one held
  // tenancy, and the whole point of a segment is that nobody enumerates it
  // by hand. Named in `skipped` like every other exclusion, so the sender
  // sees who did not get it and why.
  const suppressed = await leasesHalted(
    leases.map((lease) => lease.id),
    'suppress_marketing',
  )

  for (const lease of leases) {
    if (suppressed.has(lease.id)) {
      skipped.push({ leaseId: lease.id, why: 'lease hold — excluded from announcements' })
      continue
    }

    const tenant = lease.leaseTenants.map((lt) => lt.tenant).find((t) => t.active)
    if (!tenant) {
      skipped.push({ leaseId: lease.id, why: 'no active tenant' })
      continue
    }

    const rendered = await renderForRecipient(template, {
      tenantId: tenant.id,
      leaseId: lease.id,
      tenantName: `${tenant.firstName} ${tenant.lastName}`,
      preferredLocale: tenant.preferredLocale,
      email: tenant.email,
      phone: tenant.phone,
    })
    if (!rendered) {
      skipped.push({ leaseId: lease.id, why: 'could not build the message' })
      continue
    }
    if (rendered.missing.length > 0) {
      skipped.push({
        leaseId: lease.id,
        why: `nothing to put in ${rendered.missing.join(', ')}`,
      })
      continue
    }

    const outcomes = await notify({
      category: 'announcement',
      templateKey: 'comms.announcement',
      recipient: {
        type: 'TENANT',
        id: tenant.id,
        email: tenant.email,
        phone: tenant.phone,
      },
      context: { subject: rendered.subject, body: rendered.body, smsFooter },
      propertyId: lease.propertyId,
      sendAfter: sendAfterByLease.get(lease.id) ?? null,
      // Keyed on the FACT — this lease, this template, this property-local
      // day — so a double press sends once, matching R-044's reminders. For a
      // scheduled send the day is the one it is FOR (R-261), so scheduling
      // tomorrow's text does not collide with one sent today.
      idempotencyKey: `announcement:${templateId}:${lease.id}:${businessDate(
        sendAfterByLease.get(lease.id) ?? now,
        lease.property.timezone,
      )}`,
    })

    const row: AnnouncementRecipientResult = {
      leaseId: lease.id,
      tenantName: `${tenant.firstName} ${tenant.lastName}`,
      propertyName: lease.property.name,
      channels: [],
    }
    for (const outcome of outcomes) {
      row.channels.push({
        channel: outcome.channel,
        status: outcome.status ?? (outcome.outcome === 'duplicate' ? 'ALREADY_SENT' : 'UNKNOWN'),
        reason: outcome.reason ?? null,
      })
      if (outcome.deliveryId) {
        pending.push({ row, channel: outcome.channel, deliveryId: outcome.deliveryId })
      }
    }
    results.push(row)
  }

  const deliveryIds = pending.map((p) => p.deliveryId)

  if (sendAt) {
    // Nothing to dispatch: every delivery is DEFERRED to its own instant and
    // the hourly cron releases it. The schedule row is the index the page
    // lists and cancels by; the deliveries are the schedule itself.
    if (results.length === 0) {
      return { error: `Nothing was scheduled. ${describeSkips(skipped)}` }
    }
    const lastSendAfter = new Date(
      Math.max(...[...sendAfterByLease.values()].map((d) => d.getTime())),
    )
    let scheduleId: string
    try {
      const schedule = await prisma.announcementSchedule.create({
        data: {
          templateId,
          segment: postedSegment,
          sendAt,
          lastSendAfter,
          recipientCount: results.length,
          deliveryIds,
          createdByStaffId: actor.id,
        },
        select: { id: true },
      })
      scheduleId = schedule.id
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        return { error: 'That announcement is already scheduled for that time.' }
      }
      throw error
    }
    await audit({
      action: 'message.announcement_scheduled',
      entityType: 'MessageTemplate',
      entityId: templateId,
      after: {
        templateName: template.name,
        segmentType: segment.type,
        segmentValue: segment.value || null,
        sendAt,
        scheduleId,
        requested: leases.length,
        sent: results.length,
        removedLeaseIds: removed,
        skipped,
        sentByStaffId: actor.id,
        deliveryIds,
      },
    }).catch((error) => {
      console.error('[announcements] audit failed', error)
    })
    revalidatePath('/messages/announcements')
    const who = `${results.length} ${results.length === 1 ? 'tenant' : 'tenants'}`
    return {
      notice: `Scheduled for ${friendlyWallClock(sendAt)}, each property's local time, to ${who}. A time inside quiet hours goes out when they end.${skipped.length ? ` ${describeSkips(skipped)}` : ''}`,
      results,
    }
  }

  if (deliveryIds.length > 0) {
    // Only OUR rows — an unfiltered sweep would make this pay for the whole
    // global backlog (same rule as reminders.ts).
    await dispatchPendingNotifications(new Date(), 500, { deliveryIds }).catch((error) => {
      console.error('[announcements] dispatch failed', error)
    })

    // PER-RECIPIENT DELIVERY STATUS means what actually happened, not what
    // was queued a moment before dispatch ran — read the final rows back and
    // write them into the exact result objects the UI renders.
    const finalDeliveries = await prisma.notificationDelivery.findMany({
      where: { id: { in: deliveryIds } },
      select: { id: true, status: true, suppressedReason: true, failureCode: true },
    })
    const byId = new Map(finalDeliveries.map((d) => [d.id, d]))
    for (const { row, channel, deliveryId } of pending) {
      const final = byId.get(deliveryId)
      const entry = row.channels.find((c) => c.channel === channel)
      if (!final || !entry) continue
      entry.status = final.status
      entry.reason = final.suppressedReason ?? final.failureCode ?? entry.reason
    }
  }

  await audit({
    action: 'message.announcement_sent',
    entityType: 'MessageTemplate',
    entityId: templateId,
    after: {
      templateName: template.name,
      segmentType: segment.type,
      segmentValue: segment.value || null,
      requested: leases.length,
      sent: results.length,
      // Who the sender unticked on the review list (R-259). A tenancy that
      // matched and was not sent to has to be explainable later.
      removedLeaseIds: removed,
      // THE SKIPS ARE RECORDED, not just counted — same reasoning as
      // reminders.ts: "why didn't this tenant get it" needs an answer weeks
      // later.
      skipped,
      sentByStaffId: actor.id,
      // R-262: the history page reads per-recipient status off these rows,
      // and "resend to failed" starts from them. Ids only - the status is
      // live on NotificationDelivery, where a Twilio callback updates it.
      deliveryIds,
    },
  }).catch((error) => {
    console.error('[announcements] audit failed', error)
  })

  revalidatePath('/messages/announcements')

  if (results.length === 0) {
    return { error: `Nothing was sent. ${describeSkips(skipped)}` }
  }
  return {
    notice:
      skipped.length === 0
        ? `Sent to ${results.length} ${results.length === 1 ? 'tenant' : 'tenants'}.`
        : `Sent to ${results.length} of ${leases.length}. ${describeSkips(skipped)}`,
    results,
  }
}

/// Names the reasons rather than the count — a PM who sent 40 of 45 needs to
/// know the 5 were missing a balance, not that "5 failed".
function describeSkips(skipped: { why: string }[]): string {
  if (skipped.length === 0) return ''
  const reasons = [...new Set(skipped.map((s) => s.why))]
  return `Skipped ${skipped.length}: ${reasons.join('; ')}.`
}

export interface AudienceFormState {
  error?: string
  notice?: string
}

/// Save the segment being reviewed under a name (R-259, PRD 08 A4). Stores
/// the segment, never the ticked list: an audience is a filter.
export async function saveAudience(
  _previous: AudienceFormState,
  formData: FormData,
): Promise<AudienceFormState> {
  const { actor } = await requireScope('message.send')
  const name = String(formData.get('name') ?? '').trim()
  const posted = String(formData.get('segment') ?? '')
  if (!name) return { error: 'Give the audience a name.' }
  if (name.length > 80) return { error: 'Keep the name to 80 characters.' }
  if (!parseSegment(posted)) return { error: 'Choose who this goes to first.' }

  const audience = await prisma.audience.create({
    data: { orgId: actor.orgId, name, segment: posted, createdByStaffId: actor.id },
  })
  await audit({
    action: 'message.audience_saved',
    entityType: 'Audience',
    entityId: audience.id,
    after: { name, segment: posted },
  })
  revalidatePath('/messages/announcements')
  return { notice: `Saved "${name}". It is in the Send to list.` }
}

/// Retire a saved audience. Retired, not deleted, like a template.
/// R-261: cancel a scheduled announcement that has not gone out. Suppresses
/// the deliveries still DEFERRED - one the dispatcher has already claimed is
/// going out and is left alone - and stamps the schedule; nothing is deleted.
export async function cancelScheduledAnnouncement(formData: FormData): Promise<void> {
  const { actor, scope } = await requireScope('message.send')
  const id = String(formData.get('scheduleId') ?? '')
  const schedule = await prisma.announcementSchedule.findFirst({
    where: { id, orgId: actor.orgId, cancelledAt: null },
    include: { template: { select: { name: true } } },
  })
  if (!schedule) return
  if (!scope.everything && schedule.createdByStaffId !== actor.id) return

  const now = new Date()
  const suppressed = await prisma.notificationDelivery.updateMany({
    where: { id: { in: schedule.deliveryIds }, status: 'DEFERRED', sendAfter: { gt: now } },
    data: { status: 'SUPPRESSED', suppressedReason: 'cancelled' },
  })
  await prisma.announcementSchedule.update({
    where: { id },
    data: { cancelledAt: now, cancelledByStaffId: actor.id },
  })
  const segment = parseSegment(schedule.segment)
  await audit({
    action: 'message.announcement_cancelled',
    entityType: 'MessageTemplate',
    entityId: schedule.templateId,
    after: {
      templateName: schedule.template.name,
      segmentType: segment?.type ?? null,
      segmentValue: segment?.value || null,
      sendAt: schedule.sendAt,
      scheduleId: id,
      sent: suppressed.count,
      requested: schedule.recipientCount,
      sentByStaffId: actor.id,
    },
  })
  revalidatePath('/messages/announcements')
}

/// R-262 (PRD 08 A9): send one earlier announcement again to the recipients
/// whose delivery FAILED or BOUNCED, each on the channel that failed. A
/// SUPPRESSED row was a decision, not a failure, and a DEFERRED row with a
/// `failedAt` is R-106's own retry still in flight; neither is touched.
///
/// The address is read from the tenant NOW, not from the failed row - the
/// usual reason a text failed is a wrong number, and the resend is pressed
/// after somebody fixed it. The body is the one that was sent (R-260's
/// rule: what was previewed is what goes). The key is the failed delivery
/// itself, so a double press resends once and a second failure later is a
/// new key.
export async function resendFailedAnnouncement(formData: FormData): Promise<void> {
  const { actor, scope } = await requireScope('message.send')
  // Portfolio-wide only, for the reason announcement-history.ts gives.
  if (!scope.everything) return
  const auditLogId = String(formData.get('auditLogId') ?? '')
  const source = await prisma.auditLog.findFirst({
    where: {
      id: auditLogId,
      orgId: actor.orgId,
      action: { in: ['message.announcement_sent', 'message.announcement_scheduled'] },
    },
  })
  if (!source) return
  const after = (source.after ?? {}) as { deliveryIds?: unknown; templateName?: unknown }
  const sourceIds = Array.isArray(after.deliveryIds) ? after.deliveryIds.map(String) : []
  if (sourceIds.length === 0) return

  const failed = await prisma.notificationDelivery.findMany({
    where: { id: { in: sourceIds }, status: { in: ['FAILED', 'BOUNCED'] } },
    select: {
      failedAt: true,
      notification: {
        select: {
          channel: true,
          idempotencyKey: true,
          subject: true,
          body: true,
          propertyId: true,
          recipientType: true,
          recipientId: true,
        },
      },
    },
  })
  if (failed.length === 0) return

  const tenants = new Map(
    (
      await prisma.tenant.findMany({
        where: { id: { in: failed.map((f) => f.notification.recipientId) } },
        select: { id: true, email: true, phone: true },
      })
    ).map((t) => [t.id, t]),
  )

  const deliveryIds: string[] = []
  const now = new Date()
  for (const { failedAt, notification } of failed) {
    if (notification.recipientType !== 'TENANT') continue
    const tenant = tenants.get(notification.recipientId)
    if (!tenant) continue
    const channel = notification.channel
    if (channel !== 'EMAIL' && channel !== 'SMS' && channel !== 'PORTAL') continue
    const outcomes = await notify({
      category: 'announcement',
      templateKey: 'comms.announcement',
      recipient: { type: 'TENANT', id: tenant.id, email: tenant.email, phone: tenant.phone },
      context: { subject: notification.subject ?? '', body: notification.body },
      propertyId: notification.propertyId,
      channels: [channel],
      idempotencyKey: `${notification.idempotencyKey.replace(/:(EMAIL|SMS|PORTAL)$/, '')}:resend:${(failedAt ?? now).getTime()}`,
    })
    for (const outcome of outcomes) if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
  }

  if (deliveryIds.length > 0) {
    await dispatchPendingNotifications(now, 500, { deliveryIds }).catch((error) => {
      console.error('[announcements] resend dispatch failed', error)
    })
  }
  await audit({
    action: 'message.announcement_resent',
    entityType: 'MessageTemplate',
    entityId: source.entityId,
    after: {
      templateName: typeof after.templateName === 'string' ? after.templateName : null,
      sourceAuditLogId: source.id,
      requested: failed.length,
      sent: deliveryIds.length,
      sentByStaffId: actor.id,
      deliveryIds,
    },
  })
  revalidatePath('/messages/announcements/history')
}

export async function retireAudience(formData: FormData): Promise<void> {
  const { actor } = await requireScope('message.send')
  const id = String(formData.get('audienceId') ?? '')
  // R-285b: by id AND org, so org A cannot retire org B's audience.
  const audience = await prisma.audience.findFirst({ where: { id, orgId: actor.orgId, active: true } })
  if (!audience) return
  await prisma.audience.update({ where: { id }, data: { active: false } })
  await audit({
    action: 'message.audience_retired',
    entityType: 'Audience',
    entityId: id,
    before: { name: audience.name, segment: audience.segment },
  })
  revalidatePath('/messages/announcements')
}
