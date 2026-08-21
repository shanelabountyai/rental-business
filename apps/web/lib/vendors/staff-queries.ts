import 'server-only'

import { jobCostCents } from '@rental/core/workorders'
import { prisma } from '@rental/db'

// Reads for staff managing vendor records (MAINT-11, R-079). Vendors are
// portfolio-wide, like `JurisdictionRule` - no `propertyId` on the model,
// so nothing here is scoped through `ResolvedScope` the way a property-
// owned record would be.

export async function listVendors() {
  return prisma.vendor.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  })
}

export async function getVendor(id: string) {
  return prisma.vendor.findUnique({ where: { id } })
}

export interface VendorPaymentTotals {
  year: number
  byMethod: Record<string, number>
  totalCents: number
}

/**
 * Cumulative payments to this vendor for a calendar year, by payment
 * method - MAINT-11's own "for 1099-NEC flagging". Read from
 * `WorkOrder.invoicePaidAt`/`invoicePaymentMethod`/`jobCostCents()` - the
 * SAME "what we actually paid" figure the books already use (D-42), not a
 * second number computed a different way for this one screen.
 */
export async function vendorPaymentTotalsForYear(
  vendorId: string,
  year: number,
): Promise<VendorPaymentTotals> {
  const paid = await prisma.workOrder.findMany({
    where: {
      vendorId,
      invoicePaidAt: { gte: new Date(`${year}-01-01T00:00:00.000Z`), lt: new Date(`${year + 1}-01-01T00:00:00.000Z`) },
    },
    select: {
      invoicePaymentMethod: true,
      actualLaborCents: true,
      actualMaterialsCents: true,
      invoiceCents: true,
    },
  })

  const byMethod: Record<string, number> = {}
  let totalCents = 0
  for (const workOrder of paid) {
    const cents = jobCostCents(workOrder)
    const method = workOrder.invoicePaymentMethod ?? 'OTHER'
    byMethod[method] = (byMethod[method] ?? 0) + cents
    totalCents += cents
  }

  return { year, byMethod, totalCents }
}
