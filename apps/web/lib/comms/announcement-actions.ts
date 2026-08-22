'use server'

import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyWhere, requireScope } from '@/lib/auth/guard.ts'
import { getTemplate, renderForRecipient } from '@/lib/comms/templates.ts'
import { isSegmentType, segmentWhere } from '@/lib/comms/announcements.ts'
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
  const segmentTypeRaw = String(formData.get('segmentType') ?? '')
  const segmentValue = String(formData.get('segmentValue') ?? '')

  if (!templateId) return { error: 'Choose a template to send.' }
  if (!isSegmentType(segmentTypeRaw)) {
    return { error: 'Choose who this goes to.' }
  }

  const segmentFilter = segmentWhere(segmentTypeRaw, segmentValue)
  if (segmentFilter === null) {
    return { error: 'Choose a property, metro or tag to send to.' }
  }

  const template = await getTemplate(templateId)
  if (!template || !template.active) {
    return { error: 'That template is no longer available.' }
  }

  const scopedWhere = propertyWhere(scope)
  if (scopedWhere === null) {
    return { error: 'Nothing in your scope matches that.' }
  }

  const leases = await prisma.lease.findMany({
    where: {
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
      property: { AND: [scopedWhere, segmentFilter] },
    },
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
      context: { subject: rendered.subject, body: rendered.body },
      propertyId: lease.propertyId,
      // Keyed on the FACT — this lease, this template, this property-local
      // day — so a double press sends once, matching R-044's reminders.
      idempotencyKey: `announcement:${templateId}:${lease.id}:${businessDate(
        new Date(),
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
      segmentType: segmentTypeRaw,
      segmentValue: segmentValue || null,
      requested: leases.length,
      sent: results.length,
      // THE SKIPS ARE RECORDED, not just counted — same reasoning as
      // reminders.ts: "why didn't this tenant get it" needs an answer weeks
      // later.
      skipped,
      sentByStaffId: actor.id,
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
