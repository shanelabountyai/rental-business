// Splitting one vendor invoice across properties and categories (PAY-10,
// R-082) - the $900 handyman invoice covering three houses.
//
// THE CATEGORY IS A SCHEDULE E KEY, not a vocabulary of its own. PAY-10 asks
// that each split flow "to the right property P&L and export mapping", and
// the shortest honest way to guarantee that is to record the mapping itself
// rather than a label that has to be translated into one later. There is no
// second list to keep in step with the form.
//
// Two Schedule E lines a vendor bill could plausibly claim are deliberately
// absent from the list below:
//
// - `DEPRECIATION` and anything capitalisable. A bill for a new roof is a
//   `CapitalImprovement`, which already exists, already carries the
//   in-service date depreciation starts from, and already excludes its work
//   order from deductible repairs. Letting a split capitalise as well would
//   be a second path to the same schedule with no in-service date on it.
// - `MORTGAGE_INTEREST` / `OTHER_INTEREST`. Interest comes from a lender's
//   1098 (R-081b), not from a vendor.

import { SCHEDULE_E, type ScheduleEKey } from '../tax/schedule-e.ts'

interface Violation {
  field: string
  message: string
}

/// The expense lines a vendor can actually bill. Order is Schedule E's own.
export const INVOICE_SPLIT_CATEGORIES = [
  'ADVERTISING',
  'AUTO_TRAVEL',
  'CLEANING_MAINTENANCE',
  'COMMISSIONS',
  'INSURANCE',
  'LEGAL_PROFESSIONAL',
  'MANAGEMENT_FEES',
  'REPAIRS',
  'SUPPLIES',
  'TAXES',
  'UTILITIES',
  'OTHER',
] as const satisfies readonly ScheduleEKey[]

export type InvoiceSplitCategory = (typeof INVOICE_SPLIT_CATEGORIES)[number]

export function isInvoiceSplitCategory(value: string): value is InvoiceSplitCategory {
  return (INVOICE_SPLIT_CATEGORIES as readonly string[]).includes(value)
}

export function invoiceSplitCategoryLabel(category: string): string {
  return SCHEDULE_E[category]?.label ?? category
}

export interface InvoiceSplitInput {
  propertyId: string
  category: string
  amountCents: number | null
  workOrderId?: string | null
  description?: string | null
}

export interface SplitInvoiceInput {
  legalEntityId: string
  vendorId: string
  invoiceNumber?: string | null
  totalCents: number | null
  invoicedOn: string
  paidOn?: string | null
  paymentMethod?: string | null
  notes?: string | null
  splits: readonly InvoiceSplitInput[]
}

export function sumSplitCents(splits: readonly InvoiceSplitInput[]): number {
  return splits.reduce((total, split) => total + (split.amountCents ?? 0), 0)
}

/**
 * Every rule that makes a split invoice safe to book.
 *
 * The one that matters is the last: the splits must sum to the vendor's own
 * printed total, EXACTLY. This is the difference between a record that can be
 * reconciled against a vendor statement and one that cannot. A tolerance here
 * would be a rounding allowance nobody asked for - the amounts are integer
 * cents typed off a piece of paper, so an off-by-one is a typo, not drift,
 * and the right moment to catch a typo is while the paper is still in hand.
 *
 * `field` names are indexed (`splits.2.amountDollars`) so the form can put the
 * error on the row that caused it rather than at the top of the page.
 */
export function validateSplitInvoice(input: SplitInvoiceInput): Violation[] {
  const violations: Violation[] = []

  if (!input.legalEntityId.trim()) {
    violations.push({ field: 'legalEntityId', message: 'Choose which entity this bill belongs to.' })
  }
  if (!input.vendorId.trim()) {
    violations.push({ field: 'vendorId', message: 'Choose the vendor who sent it.' })
  }
  if (
    input.totalCents == null ||
    Number.isNaN(input.totalCents) ||
    !Number.isInteger(input.totalCents) ||
    input.totalCents <= 0
  ) {
    violations.push({ field: 'totalDollars', message: "Enter the invoice total as the vendor printed it." })
  }
  if (!input.invoicedOn || Number.isNaN(Date.parse(input.invoicedOn))) {
    violations.push({ field: 'invoicedOn', message: 'Enter the invoice date.' })
  }
  if (input.paidOn && Number.isNaN(Date.parse(input.paidOn))) {
    violations.push({ field: 'paidOn', message: 'Enter a valid date, or leave it blank until it is paid.' })
  }

  if (input.splits.length === 0) {
    violations.push({
      field: 'splits',
      message: 'Add at least one line saying which property this bill is for.',
    })
    return violations
  }

  const seenWorkOrders = new Set<string>()
  input.splits.forEach((split, index) => {
    const at = (field: string) => `splits.${index}.${field}`
    if (!split.propertyId.trim()) {
      violations.push({ field: at('propertyId'), message: 'Choose a property.' })
    }
    if (!isInvoiceSplitCategory(split.category)) {
      violations.push({ field: at('category'), message: 'Choose a category.' })
    }
    if (
      split.amountCents == null ||
      Number.isNaN(split.amountCents) ||
      !Number.isInteger(split.amountCents) ||
      split.amountCents <= 0
    ) {
      // Not "$0 or more": a zero line is a line somebody meant to fill in and
      // did not, and it would export as a visible $0 deduction.
      violations.push({ field: at('amountDollars'), message: "Enter this line's share of the bill." })
    }
    const jobId = split.workOrderId?.trim()
    if (jobId) {
      if (seenWorkOrders.has(jobId)) {
        violations.push({
          field: at('workOrderId'),
          message: 'That work order is already on another line of this invoice.',
        })
      }
      seenWorkOrders.add(jobId)
    }
  })

  // Only worth saying once the parts are individually sane - otherwise a
  // single blank amount produces two errors describing the same mistake.
  const amountsUsable =
    input.totalCents != null &&
    Number.isInteger(input.totalCents) &&
    input.splits.every((split) => split.amountCents != null && Number.isInteger(split.amountCents))

  if (amountsUsable) {
    const total = sumSplitCents(input.splits)
    if (total !== input.totalCents) {
      const off = total - (input.totalCents as number)
      violations.push({
        field: 'splits',
        message: `The lines add up to ${centsLabel(total)}, but the invoice total is ${centsLabel(input.totalCents as number)} — ${off > 0 ? 'over' : 'under'} by ${centsLabel(Math.abs(off))}.`,
      })
    }
  }

  return violations
}

/// Local rather than `formatCents` from `../money`: this message is built in
/// pure validation that a form renders verbatim, and pulling the money module
/// in for one string would make the vendors module depend on it for nothing
/// else.
function centsLabel(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`
}
