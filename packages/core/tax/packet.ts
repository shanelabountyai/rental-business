// The year-end tax packet's own schedules (RPT-07, R-081b).
//
// Everything here is pure and everything here REGROUPS what R-078 already
// classified, except the two schedules that genuinely have no source in the
// export: deposit liability (a balance, from the `Deposit` table) and the
// 1099-NEC candidate list (from vendor payments).
//
// Schedule E per property is a grouping and nothing more - `ExportLine`
// already carries `propertyId`, so a second money pipeline here would only be
// a second chance to get the sign or the timezone wrong.

import { requiresForm1099 } from '../vendors/invoice.ts'
import { SCHEDULE_E, type ScheduleEKey } from './schedule-e.ts'
import type { ExportLine } from './export.ts'

export interface ScheduleELineTotal {
  key: ScheduleEKey
  line: number
  label: string
  amountCents: number
}

export interface PropertyScheduleE {
  propertyId: string
  propertyName: string
  /// Only the lines that have money on them, in form order.
  totals: ScheduleELineTotal[]
  incomeCents: number
  expenseCents: number
  netCents: number
}

const KEY_BY_LINE = new Map<number, ScheduleEKey>(
  (Object.keys(SCHEDULE_E) as ScheduleEKey[]).map((key) => [SCHEDULE_E[key].line, key]),
)

/**
 * Schedule E totals per property.
 *
 * Schedule E is filed PER PROPERTY — the form has a column per address — but
 * R-078's export totals per entity, because that is the unit a QuickBooks
 * import wants. Both are right for their own reader; this is the grouping the
 * form actually asks for.
 *
 * CapEx, deposit and exception rows are excluded: none of them is a Schedule E
 * line, and each has its own schedule in the packet.
 */
export function scheduleEByProperty(
  lines: readonly ExportLine[],
  properties: readonly { id: string; name: string }[],
): PropertyScheduleE[] {
  return properties.map((property) => {
    const byKey = new Map<ScheduleEKey, number>()
    let incomeCents = 0
    let expenseCents = 0

    for (const line of lines) {
      if (line.propertyId !== property.id) continue
      if (line.section !== 'INCOME' && line.section !== 'EXPENSE') continue
      if (line.scheduleELine == null) continue
      const key = KEY_BY_LINE.get(line.scheduleELine)
      if (!key) continue
      byKey.set(key, (byKey.get(key) ?? 0) + line.amountCents)
      if (line.section === 'INCOME') incomeCents += line.amountCents
      else expenseCents += line.amountCents
    }

    return {
      propertyId: property.id,
      propertyName: property.name,
      totals: [...byKey.entries()]
        .map(([key, amountCents]) => ({
          key,
          line: SCHEDULE_E[key].line,
          label: SCHEDULE_E[key].label,
          amountCents,
        }))
        .sort((a, b) => a.line - b.line),
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
    }
  })
}

export interface DepositFact {
  id: string
  propertyId: string
  leaseId: string
  heldCents: number
  appliedCents: number
  refundedCents: number
  receivedAt: Date | null
  dispositionSentAt: Date | null
}

export interface PropertyDepositLiability {
  propertyId: string
  propertyName: string
  depositCount: number
  liabilityCents: number
}

/**
 * Deposit money still held at the end of the year — a BALANCE, and a
 * different question from the export's `DEPOSIT_LIABILITY` section, which is
 * deposits RECEIVED during the period.
 *
 * ==========================================================================
 * `heldCents` IS GROSS AND IS NEVER DECREMENTED. `appliedCents` and
 * `refundedCents` account for it at disposition, so what is still owed back
 * is the difference — the same arithmetic `rent-roll.ts` has always used, and
 * what `computeDisposition`'s own doc comment describes.
 *
 * AND THE DISPOSITION DATE MATTERS, which is the part a naive sum gets wrong.
 * A deposit disposed of in March 2027 was still held in full on 31 December
 * 2026: subtracting its applied and refunded amounts from the 2026 balance
 * would report a liability the owner did not yet have.
 * ==========================================================================
 *
 * A null `receivedAt` counts as received. The row exists, so the money is
 * recorded; treating "we did not write down the date" as "we never got it"
 * would understate a liability, which is the wrong direction to be wrong in.
 */
export function depositLiabilityAt(
  deposits: readonly DepositFact[],
  asOf: Date,
  propertyNames: ReadonlyMap<string, string>,
): { byProperty: PropertyDepositLiability[]; totalCents: number } {
  const byProperty = new Map<string, PropertyDepositLiability>()

  for (const deposit of deposits) {
    if (deposit.receivedAt != null && deposit.receivedAt > asOf) continue

    const settled = deposit.dispositionSentAt != null && deposit.dispositionSentAt <= asOf
    const liabilityCents = settled
      ? deposit.heldCents - deposit.appliedCents - deposit.refundedCents
      : deposit.heldCents
    if (liabilityCents === 0) continue

    const row = byProperty.get(deposit.propertyId) ?? {
      propertyId: deposit.propertyId,
      propertyName: propertyNames.get(deposit.propertyId) ?? deposit.propertyId,
      depositCount: 0,
      liabilityCents: 0,
    }
    row.depositCount += 1
    row.liabilityCents += liabilityCents
    byProperty.set(deposit.propertyId, row)
  }

  const rows = [...byProperty.values()].sort((a, b) =>
    a.propertyName.localeCompare(b.propertyName),
  )
  return {
    byProperty: rows,
    totalCents: rows.reduce((total, row) => total + row.liabilityCents, 0),
  }
}

/// A card payment is reported by the PROCESSOR on a 1099-K, not by the payer
/// on a 1099-NEC. Paying a vendor $40,000 by card and $30,000 by check is a
/// $30,000 1099-NEC, not a $70,000 one — which is why RPT-07 asks for the
/// candidate list "by payment method" rather than by total.
const NOT_1099_REPORTABLE = new Set(['CARD'])

export interface VendorPaymentFact {
  vendorId: string
  vendorName: string
  w9OnFile: boolean
  /// Keyed by `VENDOR_PAYMENT_METHODS` values.
  byMethod: Readonly<Record<string, number>>
}

export interface Form1099Candidate {
  vendorId: string
  vendorName: string
  w9OnFile: boolean
  /// Everything paid, however paid. Shown so the two figures can be compared.
  totalPaidCents: number
  /// What actually goes on the form.
  reportableCents: number
  cardCents: number
  requiresForm: boolean
  /// Over the threshold with no W-9 on file — the row somebody has to chase
  /// before January, and the reason this list exists in a tax packet at all.
  missingW9: boolean
}

/**
 * The 1099-NEC candidate list for one year.
 *
 * Returns EVERY vendor paid, not only those over the threshold, sorted by
 * reportable amount. A list that showed only the candidates would hide the
 * vendor sitting just under the line, and "just under" is a judgement the
 * filer should make with the number in front of them rather than one this
 * product should make silently.
 */
export function form1099Candidates(
  vendors: readonly VendorPaymentFact[],
): Form1099Candidate[] {
  return vendors
    .map((vendor) => {
      let totalPaidCents = 0
      let cardCents = 0
      for (const [method, cents] of Object.entries(vendor.byMethod)) {
        totalPaidCents += cents
        if (NOT_1099_REPORTABLE.has(method.toUpperCase())) cardCents += cents
      }
      const reportableCents = totalPaidCents - cardCents
      const requiresForm = requiresForm1099(reportableCents)
      return {
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        w9OnFile: vendor.w9OnFile,
        totalPaidCents,
        reportableCents,
        cardCents,
        requiresForm,
        missingW9: requiresForm && !vendor.w9OnFile,
      }
    })
    .filter((row) => row.totalPaidCents > 0)
    .sort(
      (a, b) => b.reportableCents - a.reportableCents || a.vendorName.localeCompare(b.vendorName),
    )
}
