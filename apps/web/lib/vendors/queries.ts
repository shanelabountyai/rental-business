import 'server-only'

import { prisma } from '@rental/db'

// Reads for the vendor magic-link page (D-6, MAINT-03, R-025).
//
// Scoped by the WORK ORDER the token authorizes, never by a session and
// never by a property - a vendor has no scope beyond the one job. Every
// function here takes an already-verified work order, so the authorization
// decision stays in link.ts and is not re-derived (or forgotten) per query.

/**
 * "Full context" the link carries (MAINT-03): the photos of the problem, the
 * appliance the job is about, and which access codes EXIST.
 *
 * Access codes come back WITHOUT their sealed value - just id, type and
 * label, enough to render a "reveal" button. The code itself only ever
 * leaves through `revealCodeForVendor()`, which logs the reveal (PROP-03).
 * Returning the sealed blob here and decrypting in the page would work and
 * would be wrong: the reveal would stop being an auditable event and become
 * a render.
 */
export async function vendorJobContext(workOrder: {
  id: string
  unitId: string
  ticketId: string | null
}) {
  const [photos, appliances, accessCodes, shutoffs] = await Promise.all([
    prisma.document.findMany({
      where: {
        deletedAt: null,
        // The tenant's photos of the problem and anything already uploaded
        // against this work order. Deliberately not every document at the
        // property - a vendor gets the job, not the filing cabinet.
        OR: [
          { workOrderId: workOrder.id },
          ...(workOrder.ticketId ? [{ ticketId: workOrder.ticketId }] : []),
        ],
      },
      select: { id: true, fileName: true, contentType: true, type: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.appliance.findMany({
      where: { unitId: workOrder.unitId },
      select: { id: true, category: true, make: true, model: true, serialNumber: true, filterSize: true },
      orderBy: { category: 'asc' },
    }),
    prisma.accessCode.findMany({
      where: { unitId: workOrder.unitId, effectiveTo: null },
      select: { id: true, type: true, label: true },
      orderBy: { type: 'asc' },
    }),
    prisma.shutoffLocation.findMany({
      where: { unitId: workOrder.unitId },
      select: { id: true, type: true, description: true },
      orderBy: { type: 'asc' },
    }),
  ])

  return { photos, appliances, accessCodes, shutoffs }
}
