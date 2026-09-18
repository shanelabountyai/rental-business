import 'server-only'

import {
  CATEGORY_LABELS,
  EMERGENCY_DEFINITIONS,
  type EmergencyCategory,
  type MaintenanceCategory,
  isEmergencyCategory,
} from '@rental/core/maintenance'
import { prisma } from '@rental/db'
import { type OnCallCandidate, pagingPlan } from '@rental/core/oncall'
import type { TenantScope } from '@rental/core/portal'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// Reads for the emergency intake path (MAINT-01, PROP-03, R-020).

/**
 * The shutoff this emergency needs, from the unit record (R-014).
 *
 * MAINT-01: "the relevant shutoff photo/location from the unit record
 * displays". `relevant` is the operative word - this returns the ONE shutoff
 * that helps for this emergency, not the unit's whole list. Somebody standing
 * in rising water needs the water main, immediately, not a menu including the
 * gas valve.
 *
 * Returns null when the emergency has no useful shutoff (see
 * EmergencyDefinition.shutoffType - gas and CO deliberately have none) or
 * when the unit record simply has not had one recorded yet. Both cases render
 * the same way: the safety instructions still show, with an honest note that
 * we do not have the location on file, rather than an empty box.
 */
export async function shutoffForEmergency(
  unitId: string,
  category: EmergencyCategory,
) {
  const shutoffType = EMERGENCY_DEFINITIONS[category].shutoffType
  if (!shutoffType) return null

  const [location, photo] = await Promise.all([
    prisma.shutoffLocation.findUnique({
      where: { unitId_type: { unitId, type: shutoffType } },
      select: { type: true, description: true },
    }),
    // The photo is a Document on the unit (R-014's convention: entities
    // attach photos through Document rather than a dedicated column).
    // Newest first - a re-photographed shutoff supersedes the old one.
    prisma.document.findFirst({
      where: { unitId, type: 'SHUTOFF_PHOTO', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
  ])

  if (!location && !photo) return null
  return {
    type: shutoffType,
    description: location?.description ?? null,
    photoDocumentId: photo?.id ?? null,
  }
}

/**
 * Everybody with authority to act on an emergency at this property.
 *
 * Staff holding `ticket.write` over the property, through any live
 * assignment - resolved at send time, never a stored subscriber list, for the
 * same reason R-016's own consumer resolves recipients live: who is
 * responsible for a property changes with assignments, and a copied list goes
 * stale silently.
 *
 * This is the PERMISSIONS half of the question only. Who to actually page out
 * of this set is the rota's job (packages/core/oncall) - see
 * `emergencyPagingPlan()` below, which composes the two.
 */
export async function onCallStaffForProperty(propertyId: string) {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { legalEntityId: true },
  })
  if (!property) return []

  const assignments = await prisma.staffAssignment.findMany({
    where: {
      revokedAt: null,
      staffUser: { active: true },
      role: { permissions: { has: 'ticket.write' } },
      OR: [
        { propertyId: null, legalEntityId: null },
        { legalEntityId: property.legalEntityId },
        { propertyId },
      ],
    },
    select: {
      staffUser: {
        select: {
          id: true,
          email: true,
          phone: true,
          onCallFrom: true,
          onCallUntil: true,
        },
      },
    },
  })

  // One page each, however many grants reach them.
  const byId = new Map<string, OnCallCandidate>()
  for (const assignment of assignments) {
    byId.set(assignment.staffUser.id, assignment.staffUser)
  }
  return [...byId.values()]
}

/**
 * Who gets woken up right now (MAINT-01: "on-call staff are paged immediately
 * regardless of hour"; MAINT-12's on-call toggle and escalation chain, R-029).
 *
 * The narrowing R-020 left open and R-026 measured the cost of. If somebody
 * is actually on call, page them; if nobody is, page everybody, because a 3am
 * gas leak reaching nobody is the one outcome this may never produce. The
 * reasoning lives in packages/core/oncall/rota.ts - this function is only the
 * query that feeds it.
 */
export async function emergencyPagingPlan(propertyId: string, now = new Date()) {
  return pagingPlan(await onCallStaffForProperty(propertyId), now)
}

/**
 * Emergencies nobody has acknowledged yet (NOTIF-05, R-029).
 *
 * Bounded to the last 24 hours on purpose. An emergency still unacknowledged
 * a day later is not an escalation problem any more - the chain has already
 * fired at everybody it can reach - and leaving it in the sweep forever means
 * every tick re-evaluates rows whose answer cannot change.
 */
export async function unacknowledgedEmergencies(
  now: Date,
  /**
   * Narrows the sweep to specific tickets - the same `only:` shape
   * `dispatchPendingNotifications` has carried since R-016, and for the same
   * reason (R-102b).
   *
   * A test asserting "my emergency was left alone" does not need to evaluate,
   * page for, and pay for every other emergency in a shared database. Without
   * this the cost of every such test grows with the number of unacknowledged
   * emergencies any spec or e2e run has ever created, which is exactly how
   * this one came to blow a 30s timeout.
   *
   * The five-minute cron passes nothing and sweeps globally, which is what a
   * cron is for.
   */
  only?: { ticketIds: readonly string[] },
) {
  // An explicit empty set means "none of mine are open" and must not fall
  // through to a global sweep.
  if (only && only.ticketIds.length === 0) return []

  return prisma.ticket.findMany({
    where: {
      ...(only ? { id: { in: [...only.ticketIds] } } : {}),
      priority: 'EMERGENCY',
      acknowledgedAt: null,
      // From when it BECAME an emergency (R-223), which is its creation only
      // for the portal's own intake.
      emergencyAt: { gte: new Date(now.getTime() - 24 * 3_600_000), lte: now },
      status: { notIn: ['CLOSED', 'MERGED'] },
    },
    // A tick that could pick up an unbounded number of rows is the shape
    // R-026 measured the cost of. Nothing real reaches this; a runaway does.
    take: 100,
    orderBy: { emergencyAt: 'asc' },
    select: {
      id: true,
      emergencyAt: true,
      acknowledgedAt: true,
      category: true,
      propertyId: true,
      unitId: true,
      property: { select: { name: true, addressLine1: true } },
      unit: { select: { name: true } },
      tenant: { select: { firstName: true, lastName: true, phone: true } },
    },
  })
}

/**
 * Of these tickets, which have already had the chain fire (R-029).
 *
 * The five-minute tick re-evaluates the same unacknowledged emergency until
 * somebody acknowledges it or a day passes. Notification idempotency makes
 * re-sending harmless, but not free - without this, an emergency nobody
 * acknowledges costs 288 rounds of "resolve the rota, attempt a write per
 * recipient per channel, watch every one deduplicate". One query up front
 * replaces all of it, and reads the answer off the sends themselves rather
 * than off a column that could disagree with them.
 */
export async function alreadyEscalatedTicketIds(
  ticketIds: readonly string[],
): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set()
  const sent = await prisma.notification.findMany({
    where: {
      OR: ticketIds.map((id) => ({
        idempotencyKey: { startsWith: `emergency-escalation:${id}:` },
      })),
    },
    select: { idempotencyKey: true },
  })
  return new Set(
    sent.map((notification) => notification.idempotencyKey.split(':')[1] ?? ''),
  )
}

/// The tenant's current unit, for resolving the shutoff before they submit.
export async function unitForEmergency(scope: TenantScope) {
  if (scope.leaseIds.length === 0) return null
  return prisma.lease.findFirst({
    where: { id: { in: [...scope.leaseIds] } },
    orderBy: { startsOn: 'desc' },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      unit: { select: { name: true } },
      property: { select: { name: true, addressLine1: true } },
    },
  })
}

/**
 * Who to call for this trade at 3am (MAINT-12's "emergency vendor list per
 * trade", R-029).
 *
 * Emergency-available vendors FIRST and marked as such, then the rest of the
 * trade. Not filtered down to the emergency list, on purpose - the flag is
 * new, most vendors will not have it set for a long time, and a list that
 * showed nothing until somebody did the data entry would be worse than the
 * phone numbers in somebody's contacts, which is what this replaces.
 */
export async function emergencyVendorsForTrade(trade: string | null) {
  if (!trade) return []
  const vendors = await prisma.vendor.findMany({
    where: { active: true, trades: { has: trade } },
    select: {
      id: true,
      name: true,
      phone: true,
      emergencyAvailable: true,
    },
    orderBy: { name: 'asc' },
  })
  return vendors.sort(
    (a, b) => Number(b.emergencyAvailable) - Number(a.emergencyAvailable),
  )
}

/// What a page calls this emergency. The tenant's own words for one of
/// MAINT-01's emergency categories ("I smell gas"); the ordinary category
/// label for a ticket staff escalated (R-223), which can be anything,
/// including a text nobody has categorised yet.
export function emergencyLabelFor(category: string): string {
  if (isEmergencyCategory(category)) return EMERGENCY_DEFINITIONS[category].label
  return CATEGORY_LABELS[category as MaintenanceCategory] ?? 'Maintenance request'
}

const PAGE_SELECT = {
  id: true,
  propertyId: true,
  category: true,
  description: true,
  petWarning: true,
  entryPermission: true,
  property: { select: { name: true, addressLine1: true } },
  unit: { select: { name: true } },
  tenant: { select: { firstName: true, lastName: true, phone: true } },
} as const

/**
 * Sends one template to everybody the rota says to wake for this ticket,
 * then flushes exactly those sends in the same request.
 *
 * Never throws: every caller has already committed the ticket, and a
 * provider outage must not turn "we recorded your emergency" into an error
 * screen. A failed page is recorded on the notification's own delivery row
 * (R-016), which is where a support conversation looks.
 */
async function pageRota(
  ticketId: string,
  templateKey: 'maintenance.emergency' | 'maintenance.emergency_suggested',
): Promise<void> {
  try {
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: PAGE_SELECT,
    })
    // WHO, decided by the rota (R-029) rather than by paging everybody. When
    // nobody is on call this is still everybody - see packages/core/oncall
    // for why that fallback is the safe direction and not an oversight.
    const { recipients } = await emergencyPagingPlan(ticket.propertyId)
    const context = {
      emergencyLabel: emergencyLabelFor(ticket.category),
      propertyName: ticket.property.name,
      addressLine1: ticket.property.addressLine1,
      unitName: ticket.unit?.name ?? '',
      tenantName: ticket.tenant
        ? `${ticket.tenant.firstName} ${ticket.tenant.lastName}`
        : 'the reporter',
      tenantPhone: ticket.tenant?.phone ?? null,
      petWarning: ticket.petWarning,
      entryPermission: ticket.entryPermission,
      tenantWords: ticket.description,
      ticketUrl: `${process.env.AUTH_URL ?? ''}/maintenance/${ticket.id}`,
    }

    // In PARALLEL, and `allSettled`: every page is independent, a tenant
    // standing in sewage is waiting on this whole function, and one
    // recipient with a broken record must not stop the others being paged.
    const results = await Promise.allSettled(
      recipients.map((staff) =>
        notify({
          category: 'maintenance_emergency',
          templateKey,
          recipient: { type: 'STAFF', id: staff.id, email: staff.email, phone: staff.phone },
          context,
          propertyId: ticket.propertyId,
          // Keyed on the ticket: one page per ticket per recipient, however
          // many times a jittery tenant taps Send or a PM re-saves.
          idempotencyKey: `${templateKey === 'maintenance.emergency' ? 'emergency' : 'emergency-suggested'}:${ticket.id}:${staff.id}`,
        }),
      ),
    )
    const deliveryIds: string[] = []
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`[emergency] a page could not be recorded for ${ticketId}`, result.reason)
        continue
      }
      for (const outcome of result.value) {
        if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
      }
    }

    // The "immediately" half, scoped to THIS ticket's own pages. An
    // unscoped sweep here was a real bug (R-020): it sent the oldest queued
    // deliveries in the whole system first, so a page could sit behind a
    // hundred unrelated notifications.
    await dispatchPendingNotifications(new Date(), 100, { deliveryIds })
  } catch (error) {
    console.error(`[emergency] failed to page on-call for ticket ${ticketId}`, error)
  }
}

/// A ticket IS an emergency - the portal's own intake (R-020) or a person
/// who escalated one (R-023). Wakes the rota; R-029's escalation chain
/// follows from `Ticket.emergencyAt` if nobody acknowledges.
export async function pageOnCall(ticketId: string): Promise<void> {
  await pageRota(ticketId, 'maintenance.emergency')
}

/**
 * A ticket MIGHT be an emergency (R-223): a text or email whose words
 * matched habitability language. Tells whoever is on call, with the tenant's
 * own words, so a person decides - it does not make the ticket EMERGENCY,
 * so no escalation chain runs behind it and nobody past the rota is woken.
 *
 * Night delivery is deliberate (owner decision, D-242): `maintenance_emergency`
 * bypasses quiet hours, because the case this exists for is the tenant who
 * texts at 23:10 and will never open the portal.
 */
export async function suggestEmergencyToOnCall(ticketId: string): Promise<void> {
  await pageRota(ticketId, 'maintenance.emergency_suggested')
}
