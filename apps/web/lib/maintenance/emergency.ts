import 'server-only'

import { EMERGENCY_DEFINITIONS, type EmergencyCategory } from '@rental/core/maintenance'
import { prisma } from '@rental/db'
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
 * Who gets woken up (MAINT-01: "on-call staff are paged immediately
 * regardless of hour").
 *
 * Staff holding `ticket.write` over the property, through any live
 * assignment - resolved at send time, never a stored subscriber list, for the
 * same reason R-016's own consumer resolves recipients live: who is
 * responsible for a property changes with assignments, and a copied list goes
 * stale silently.
 *
 * THIS IS NOT A REAL ON-CALL ROSTER, and it deliberately over-pages rather
 * than under-pages. R-029 (After-hours routing, MAINT-12/NOTIF-05) owns the
 * on-call toggle and the escalation chain - page → SMS → call → backup. Until
 * it exists, "everyone who could act on this property" is the honest
 * available answer, and waking three people for a gas leak is the correct
 * failure direction while waking none is not.
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
      staffUser: { select: { id: true, email: true, phone: true } },
    },
  })

  // One page each, however many grants reach them.
  const byId = new Map<
    string,
    { id: string; email: string; phone: string | null }
  >()
  for (const assignment of assignments) {
    byId.set(assignment.staffUser.id, assignment.staffUser)
  }
  return [...byId.values()]
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
