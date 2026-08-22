import 'server-only'

import {
  type AccountingBasis,
  type ExportLine,
  type Form1099Candidate,
  type PropertyDepositLiability,
  type PropertyScheduleE,
  depositLiabilityAt,
  form1099Candidates,
  scheduleEByProperty,
} from '@rental/core/tax'
import { jobCostCents } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { taxExportFacts } from '@/lib/tax/queries.ts'

// The year-end tax packet's reads (RPT-07, R-081b).
//
// Three of its five schedules come straight out of R-078's export - Schedule
// E per property and the CapEx schedule are groupings of `TaxExport.lines`,
// and the exception list is `TaxExport.exceptions` unchanged. Only deposit
// liability and the 1099-NEC list need their own queries, because neither
// has anything to do with income or expense in the period.

export interface TaxPacket {
  legalEntityId: string
  legalEntityName: string
  year: number
  basis: AccountingBasis
  scheduleE: PropertyScheduleE[]
  capex: ExportLine[]
  depositLiability: { byProperty: PropertyDepositLiability[]; totalCents: number }
  vendors: Form1099Candidate[]
  exceptions: ExportLine[]
  exceptionCents: number
  /// Entity-wide, from the export itself rather than re-summed here, so the
  /// packet's headline cannot drift from the tax export's.
  incomeCents: number
  expenseCents: number
}

export async function taxPacket(
  scope: ResolvedScope,
  legalEntityId: string,
  year: number,
  basis: AccountingBasis,
): Promise<TaxPacket | null> {
  const report = await taxExportFacts(scope, legalEntityId, year, basis)
  if (!report) return null

  const properties = scope.availableProperties.filter(
    (property) =>
      property.legalEntityId === legalEntityId && scope.propertyIds.includes(property.id),
  )
  const propertyIds = properties.map((property) => property.id)

  // 31 December of the tax year, as an instant. Deliberately UTC rather than
  // per-property: a deposit balance is a legal position on a date, not an
  // event with a local clock, and the alternative - one entity reporting its
  // liability as of several different moments - is worse than being a few
  // hours out at the boundary.
  const asOf = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))

  const [deposits, propertyRows, vendorJobs] = await Promise.all([
    prisma.deposit.findMany({
      where: { propertyId: { in: propertyIds } },
      select: {
        id: true,
        propertyId: true,
        leaseId: true,
        heldCents: true,
        appliedCents: true,
        refundedCents: true,
        receivedAt: true,
        dispositionSentAt: true,
      },
    }),
    prisma.property.findMany({
      where: { id: { in: propertyIds } },
      select: { id: true, name: true },
    }),
    // ONE QUERY FOR EVERY VENDOR, not one per vendor. The existing
    // `vendorPaymentTotalsForYear` takes a single id, and a candidate list
    // built on it would be one round trip per vendor on a screen somebody
    // opens in January with the whole portfolio in scope.
    //
    // The year window is the same hard UTC one that function uses. A vendor
    // total is not a per-property figure - the same cheque can cover jobs at
    // three houses in two zones - so there is no property clock to read it
    // in, and the 1099 itself is a calendar-year federal form.
    prisma.workOrder.findMany({
      where: {
        propertyId: { in: propertyIds },
        vendorId: { not: null },
        invoicePaidAt: {
          gte: new Date(`${year}-01-01T00:00:00.000Z`),
          lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
        },
      },
      select: {
        invoicePaymentMethod: true,
        actualLaborCents: true,
        actualMaterialsCents: true,
        invoiceCents: true,
        vendor: { select: { id: true, name: true, w9OnFile: true } },
      },
    }),
  ])

  const propertyNames = new Map(propertyRows.map((row) => [row.id, row.name]))

  const byVendor = new Map<
    string,
    { vendorId: string; vendorName: string; w9OnFile: boolean; byMethod: Record<string, number> }
  >()
  for (const job of vendorJobs) {
    if (!job.vendor) continue
    const row = byVendor.get(job.vendor.id) ?? {
      vendorId: job.vendor.id,
      vendorName: job.vendor.name,
      w9OnFile: job.vendor.w9OnFile,
      byMethod: {},
    }
    // The BOOKS' number (D-42) - the invoice where there is one. The same
    // figure the tax export deducts, so a vendor's 1099 total and their jobs'
    // expense lines cannot disagree.
    const method = (job.invoicePaymentMethod ?? 'OTHER').toUpperCase()
    row.byMethod[method] = (row.byMethod[method] ?? 0) + jobCostCents(job)
    byVendor.set(job.vendor.id, row)
  }

  return {
    legalEntityId: report.legalEntityId,
    legalEntityName: report.legalEntityName,
    year,
    basis,
    scheduleE: scheduleEByProperty(
      report.lines,
      propertyRows.map((row) => ({ id: row.id, name: row.name })),
    ),
    capex: report.lines.filter((line) => line.section === 'CAPEX'),
    depositLiability: depositLiabilityAt(deposits, asOf, propertyNames),
    vendors: form1099Candidates([...byVendor.values()]),
    exceptions: report.exceptions,
    exceptionCents: report.exceptionCents,
    incomeCents: report.incomeCents,
    expenseCents: report.expenseCents,
  }
}
