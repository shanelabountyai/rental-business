// Owner-side outlay nobody invoiced (RPT-05/RPT-07, R-193): the property tax
// bill, the landlord policy, the management fee.
//
// WHY A TABLE OF ITS OWN, when D-76 already lets a vendor-invoice split carry
// these Schedule E lines. A split needs a `Vendor`, and a county tax office
// entered as one sits in every assignment picker beside the plumbers. Neither
// path is wrong; the form on each page names the other so one bill is not
// entered twice (D-208).
//
// NOT AN ACCRUAL ENGINE (D-201). A monthly recurrence is expanded ON READ into
// the months that have actually arrived. Nothing is written ahead, nothing
// accrues, and stopping it is one date.

import { type BusinessDate, dueDateInMonth } from '../scheduling/local-time.ts'
import type { ScheduleEKey } from './schedule-e.ts'

interface Violation {
  field: string
  message: string
}

/// The lines an owner pays without a vendor's bill. Absent on purpose:
/// REPAIRS and CLEANING_MAINTENANCE belong to work orders, UTILITIES to
/// `UtilityBill`, MORTGAGE_INTEREST to the lender's 1098 and DEPRECIATION to
/// `CapitalImprovement`. Each of those already reaches the export, so a
/// second way in is a deduction claimed twice.
export const PROPERTY_EXPENSE_CATEGORIES = [
  'ADVERTISING',
  'AUTO_TRAVEL',
  'COMMISSIONS',
  'INSURANCE',
  'LEGAL_PROFESSIONAL',
  'MANAGEMENT_FEES',
  'OTHER_INTEREST',
  'SUPPLIES',
  'TAXES',
  'OTHER',
] as const satisfies readonly ScheduleEKey[]

/// The property picker's value for a cost of the whole entity. A select's
/// empty option is its disabled placeholder, so "no property" needs a real
/// value of its own.
export const WHOLE_ENTITY_OPTION = 'ENTITY'

export function isPropertyExpenseCategory(value: string): boolean {
  return (PROPERTY_EXPENSE_CATEGORIES as readonly string[]).includes(value)
}

export interface PropertyExpenseInput {
  legalEntityId: string
  /// Null for a cost of the entity as a whole.
  propertyId: string | null
  category: string
  amountCents: number | null
  paidOn: string
  description: string
}

export function validatePropertyExpense(
  input: PropertyExpenseInput,
  today: BusinessDate,
): Violation[] {
  const violations: Violation[] = []
  if (!input.legalEntityId.trim()) {
    violations.push({ field: 'legalEntityId', message: 'Choose which entity paid it.' })
  }
  if (input.propertyId != null && !input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'Choose a property, or the whole entity.' })
  }
  if (!isPropertyExpenseCategory(input.category)) {
    violations.push({ field: 'category', message: 'Choose a category.' })
  }
  if (
    input.amountCents == null ||
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0
  ) {
    violations.push({ field: 'amountDollars', message: 'Enter the amount paid.' })
  }
  // Strict shape, not `Date.parse`: the value is printed through
  // `friendlyBusinessDate`, which throws on anything else.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) || Number.isNaN(Date.parse(input.paidOn))) {
    violations.push({ field: 'paidOn', message: 'Enter the date it was paid.' })
  } else if (input.paidOn > today) {
    // A future payment is a forecast, and a forecast in "All expenses" is
    // the accrual engine D-201 refuses.
    violations.push({ field: 'paidOn', message: 'That date has not happened yet.' })
  }
  if (!input.description.trim()) {
    violations.push({ field: 'description', message: 'Say what it was, e.g. "2026 county tax".' })
  }
  return violations
}

/**
 * The days an expense was paid on, up to and including `through`.
 *
 * A one-off is its own date. A monthly one repeats on the first payment's
 * day of the month, clamped the way a lease due on the 31st is
 * (`dueDateInMonth`), and stops at whichever comes first of its end date and
 * `through`. `through` is today, so a series never reaches a month that has
 * not arrived.
 */
export function expenseOccurrences(
  expense: {
    paidOn: BusinessDate
    recursMonthly: boolean
    recurrenceEndsOn: BusinessDate | null
  },
  through: BusinessDate,
): BusinessDate[] {
  if (!expense.recursMonthly) return [expense.paidOn]

  const end =
    expense.recurrenceEndsOn != null && expense.recurrenceEndsOn < through
      ? expense.recurrenceEndsOn
      : through
  const day = Number(expense.paidOn.slice(8, 10))
  let year = Number(expense.paidOn.slice(0, 4))
  let month = Number(expense.paidOn.slice(5, 7))

  const days: BusinessDate[] = []
  // Bounded for the same reason `monthStartsBetween` is: a malformed date
  // must not hang a request.
  while (days.length < 1200) {
    const date = dueDateInMonth(year, month, day)
    if (date > end) break
    days.push(date)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return days
}
