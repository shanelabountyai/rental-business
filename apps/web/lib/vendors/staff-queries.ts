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
 *
 * SPLIT VENDOR INVOICES COUNT TOO (R-082). A bill recorded as a
 * `VendorInvoice` may cover several houses and name no work order at all, so
 * a vendor paid entirely that way would total zero here and never cross the
 * 1099 threshold - an under-report against a federal filing obligation, and a
 * silent one. The invoice's own `totalCents` is the payment, not the sum of
 * its splits: the splits are how the money was BOOKED, and they already equal
 * the total by construction, but the total is what the vendor was actually
 * handed.
 *
 * No double counting: a work order named by a split is excluded from the
 * work-order side, exactly as the tax export excludes it, because the split
 * invoice already carries its share.
 */
export async function vendorPaymentTotalsForYear(
  vendorId: string,
  year: number,
): Promise<VendorPaymentTotals> {
  const paidIn = {
    gte: new Date(`${year}-01-01T00:00:00.000Z`),
    lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
  }

  const [paid, invoices] = await Promise.all([
    prisma.workOrder.findMany({
      where: {
        vendorId,
        invoicePaidAt: paidIn,
        // Carried by a split invoice below instead - see the doc comment.
        invoiceSplit: null,
      },
      select: {
        invoicePaymentMethod: true,
        actualLaborCents: true,
        actualMaterialsCents: true,
        invoiceCents: true,
      },
    }),
    prisma.vendorInvoice.findMany({
      where: { vendorId, paidAt: paidIn },
      select: { totalCents: true, paymentMethod: true },
    }),
  ])

  const byMethod: Record<string, number> = {}
  let totalCents = 0
  const add = (cents: number, method: string | null) => {
    const key = method ?? 'OTHER'
    byMethod[key] = (byMethod[key] ?? 0) + cents
    totalCents += cents
  }

  for (const workOrder of paid) add(jobCostCents(workOrder), workOrder.invoicePaymentMethod)
  for (const invoice of invoices) add(invoice.totalCents, invoice.paymentMethod)

  return { year, byMethod, totalCents }
}
