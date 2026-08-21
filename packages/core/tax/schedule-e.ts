// The Schedule E chart of accounts (RPT-03, R-078).
//
// NOT LEGAL OR TAX ADVICE, and the export built on this says so on its own
// first line. What this file encodes is a DEFAULT mapping from the things
// this product records to the lines of IRS Schedule E Part I, so that a
// year's money arrives at a CPA already sorted instead of as a ledger dump.
// A CPA disagreeing with a mapping is an ordinary event; the point is that
// the mapping is written down, visible on the export, and the same every
// year rather than re-invented in a spreadsheet each January.
//
// Every line carries a QuickBooks account name because RPT-03 asks for a
// QuickBooks-mapped export and QBO imports by account NAME, not by Schedule
// E line number. The names are QuickBooks' own rental-property defaults.
// Per-entity overrides are NOT built - OQ-8 (whose books, which system,
// cash or accrual) is still open, and inventing a mapping-override UI before
// anyone has said what they are mapping TO is the wrong order.

export interface ScheduleELine {
  /// The line number on Schedule E Part I.
  line: number
  label: string
  /// The QuickBooks account this maps to on import.
  quickBooksAccount: string
}

export const SCHEDULE_E: Record<string, ScheduleELine> = {
  RENTS_RECEIVED: { line: 3, label: 'Rents received', quickBooksAccount: 'Rental Income' },
  ADVERTISING: { line: 5, label: 'Advertising', quickBooksAccount: 'Advertising' },
  AUTO_TRAVEL: { line: 6, label: 'Auto and travel', quickBooksAccount: 'Automobile Expense' },
  CLEANING_MAINTENANCE: {
    line: 7,
    label: 'Cleaning and maintenance',
    quickBooksAccount: 'Cleaning and Maintenance',
  },
  COMMISSIONS: { line: 8, label: 'Commissions', quickBooksAccount: 'Commissions and Fees' },
  INSURANCE: { line: 9, label: 'Insurance', quickBooksAccount: 'Insurance Expense' },
  LEGAL_PROFESSIONAL: {
    line: 10,
    label: 'Legal and other professional fees',
    quickBooksAccount: 'Legal and Professional Fees',
  },
  MANAGEMENT_FEES: { line: 11, label: 'Management fees', quickBooksAccount: 'Management Fees' },
  MORTGAGE_INTEREST: {
    line: 12,
    label: 'Mortgage interest paid to banks',
    quickBooksAccount: 'Mortgage Interest Expense',
  },
  OTHER_INTEREST: { line: 13, label: 'Other interest', quickBooksAccount: 'Interest Expense' },
  REPAIRS: { line: 14, label: 'Repairs', quickBooksAccount: 'Repairs and Maintenance' },
  SUPPLIES: { line: 15, label: 'Supplies', quickBooksAccount: 'Supplies' },
  TAXES: { line: 16, label: 'Taxes', quickBooksAccount: 'Taxes and Licenses' },
  UTILITIES: { line: 17, label: 'Utilities', quickBooksAccount: 'Utilities' },
  DEPRECIATION: {
    line: 18,
    label: 'Depreciation expense or depletion',
    quickBooksAccount: 'Depreciation Expense',
  },
  OTHER: { line: 19, label: 'Other', quickBooksAccount: 'Other Expenses' },
}

export type ScheduleEKey = keyof typeof SCHEDULE_E

/**
 * Where a charge's money lands on Schedule E.
 *
 * `'RENTS_RECEIVED'` for essentially all of it: the IRS treats a tenant's
 * late fee, pet rent and utility reimbursement as rental income on line 3
 * alongside the rent itself - they are not separate income lines on the
 * form, however separate they are in this product's own ledger.
 *
 * Two values are deliberately NOT income:
 *
 * - `DEPOSIT` is a LIABILITY, not income. Money held against a future
 *   obligation is not earned until it is forfeited or applied, and R-071's
 *   disposition is what turns it into either. Counting a deposit as rent
 *   received overstates income in the move-in year and understates it in the
 *   year it is actually kept. It goes on the export's deposit-liability
 *   section instead of vanishing.
 * - `OTHER` means nobody classified it. Mapping it to rents received would
 *   be a guess wearing the costume of a fact, so it lands on the exception
 *   list - which is the whole point of RPT-03's "every line carries a
 *   mapping or lands on an unmapped exception list".
 */
export type ChargeIncomeMapping = ScheduleEKey | 'DEPOSIT_LIABILITY' | 'UNMAPPED'

export const CHARGE_TYPE_MAPPING: Record<string, ChargeIncomeMapping> = {
  RENT: 'RENTS_RECEIVED',
  LATE_FEE: 'RENTS_RECEIVED',
  NSF_FEE: 'RENTS_RECEIVED',
  UTILITY: 'RENTS_RECEIVED',
  RUBS_ALLOCATION: 'RENTS_RECEIVED',
  PET_RENT: 'RENTS_RECEIVED',
  PET_FEE: 'RENTS_RECEIVED',
  CHARGEBACK: 'RENTS_RECEIVED',
  CONCESSION: 'RENTS_RECEIVED',
  LEGAL_COST: 'RENTS_RECEIVED',
  DEPOSIT: 'DEPOSIT_LIABILITY',
  OTHER: 'UNMAPPED',
}

/**
 * The mapping for a ledger row, which may have no charge behind it at all.
 *
 * A null `chargeType` is the ordinary case for the largest income line in
 * the system: rent billed by the Stripe SUBSCRIPTION raises no `Charge` row,
 * so its ledger entry has nothing to join to (see `webhook.ts`'s remainder
 * row). That is money that arrived on a rent invoice, and calling it rents
 * received is a statement about where it came from rather than a guess about
 * what it was for.
 */
export function ledgerIncomeMapping(chargeType: string | null): ChargeIncomeMapping {
  if (chargeType == null) return 'RENTS_RECEIVED'
  return CHARGE_TYPE_MAPPING[chargeType] ?? 'UNMAPPED'
}

/**
 * The Schedule E line for a maintenance job.
 *
 * Turn work is line 7 and a repair is line 14 - a distinction the form draws
 * and this product can honestly answer, because a make-ready job already
 * carries `turnoverProjectId` (R-072). A job whose cost was CAPITALISED does
 * not reach here at all: it is excluded upstream, since the same dollars
 * cannot be both a deduction and a depreciable asset.
 */
export function workOrderExpenseLine(facts: { turnoverProjectId: string | null }): ScheduleEKey {
  return facts.turnoverProjectId != null ? 'CLEANING_MAINTENANCE' : 'REPAIRS'
}

/**
 * Schedule E lines this product cannot yet fill, and why.
 *
 * Rendered on the export so a reader is told what is missing rather than
 * left to infer from a blank that the number was zero. A silently absent
 * expense line is a return that overstates income.
 */
export const UNSOURCED_LINES: ReadonlyArray<{ key: ScheduleEKey; reason: string }> = [
  { key: 'ADVERTISING', reason: 'Listing spend is not recorded as money anywhere yet.' },
  { key: 'AUTO_TRAVEL', reason: 'No mileage log is captured (RPT-07 names one; nothing writes it).' },
  { key: 'COMMISSIONS', reason: 'Leasing commissions are not recorded as money.' },
  {
    key: 'INSURANCE',
    reason: 'InsurancePolicy records coverage, not premiums paid - there is no amount to export.',
  },
  { key: 'MANAGEMENT_FEES', reason: 'Self-managed; no management-fee expense is recorded.' },
  {
    key: 'MORTGAGE_INTEREST',
    reason: 'Mortgage records the loan, not the payments. 1098 reconciliation is R-081.',
  },
  { key: 'OTHER_INTEREST', reason: 'No non-mortgage interest is recorded.' },
  { key: 'SUPPLIES', reason: 'Owner-purchased supplies outside a work order are not recorded.' },
  { key: 'TAXES', reason: 'Property-tax DUE DATES are tracked (R-077); amounts paid are not.' },
  {
    key: 'DEPRECIATION',
    reason:
      'Deliberately not computed. Method, recovery period and convention are the preparer’s call; the CapEx schedule gives them what they need to make it.',
  },
]
