import 'server-only'

import { EMERGENCY_DEFINITIONS, type EmergencyCategory } from '@rental/core/maintenance'
import { prisma } from '@rental/db'
import { type OnCallCandidate, pagingPlan } from '@rental/core/oncall'
import type { TenantScope } from '@rental/core/portal'

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
export async function unacknowledgedEmergencies(now: Date) {
  return prisma.ticket.findMany({
    where: {
      priority: 'EMERGENCY',
      acknowledgedAt: null,
      createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000), lte: now },
      status: { notIn: ['CLOSED', 'MERGED'] },
    },
    // A tick that could pick up an unbounded number of rows is the shape
    // R-026 measured the cost of. Nothing real reaches this; a runaway does.
    take: 100,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      createdAt: true,
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
