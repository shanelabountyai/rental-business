// The deposit disposition itself (INSP-03, R-071; PAY-07, D-4).
//
// `deposits.ts`'s own `depositHeldCents()` comment names this file: "which
// [movement is APPLIED vs RETURNED] - R-071 owns the disposition that
// decides which." This is that decision, plus the three other pieces
// INSP-03 asks for - a proration-style depreciation check, an "unsupported"
// flag, and the letter's own text - all pure, all in core (D-4: nothing
// here needs a database, and nothing here is a statute this product could
// silently get wrong by hardcoding).

import { type Cents, assertCents } from '../money/money.ts'

export interface DispositionTotals {
  heldCents: Cents
  deductedCents: Cents
  /// Money the tenant separately owes on the ordinary ledger (unpaid rent,
  /// fees) - NOT deposit deductions. Read from `balanceCents()` at
  /// finalize time; a credit balance (negative) is nothing owed, and comes
  /// back to the tenant as `ledgerCreditCents`.
  outstandingLedgerCents: Cents
  /// Kept against the liability - deductions plus any outstanding balance,
  /// never more than what was actually held.
  appliedCents: Cents
  /// The part of `appliedCents` that satisfies the ORDINARY LEDGER - unpaid
  /// rent and fees - rather than the deductions. R-209: the disposition has
  /// to push this to Stripe as money received, or the letter says the
  /// arrears were settled and `balanceCents()` goes on reporting them for
  /// ever.
  ///
  /// LEDGER FIRST, DEDUCTIONS SECOND, and that ordering is what keeps the
  /// letter true rather than a preference. No statute orders the two, but
  /// `dispositionLetterText` states the outstanding balance "was also
  /// applied" unconditionally whenever there is one - so on a deposit too
  /// small to cover both, satisfying the deductions first would print a
  /// sentence that is false by the difference. Ledger first makes that
  /// sentence exact in every case, and the shortfall lands in
  /// `additionalOwedCents`, which names no particular debt.
  ledgerAppliedCents: Cents
  /// Given back to the tenant OUT OF THE DEPOSIT. Deposit money only, even
  /// when a credit is returned with it: this is what `Deposit.refundedCents`
  /// stores and what `depositLiabilityCents` subtracts, and a figure larger
  /// than the deposit would take the liability below zero on the rent roll
  /// and the year-end packet.
  refundedCents: Cents
  /// What the tenant still owes AFTER the full deposit is applied and after
  /// any credit on their account has been set against the rest (D-307).
  /// Disclosed in the letter.
  additionalOwedCents: Cents
  /// The DEDUCTION half of `additionalOwedCents` (R-215). The ledger half is
  /// already a receivable - it is still on the ledger - but damage beyond the
  /// deposit exists nowhere except this arithmetic until something bills it,
  /// so this is the number finalize raises as its own charge (D-233).
  /// `additionalOwedCents` always equals this plus the arrears left unpaid.
  /// NET of `creditAppliedCents`: only the difference is invoiced.
  uncoveredDeductionsCents: Cents
  /// A credit balance on the tenant's ledger when the letter is written
  /// (D-303) - normally the move-out proration credit, days paid for and
  /// never lived (D-302). The tenant's rent, not their deposit, so it is
  /// never part of `appliedCents` or `refundedCents`. Always exactly
  /// `creditAppliedCents + creditRefundedCents`.
  ledgerCreditCents: Cents
  /// The part of that credit SET AGAINST DEDUCTIONS THE DEPOSIT COULD NOT
  /// COVER (D-307), before any of it is returned. Refunding the credit in
  /// full while invoicing the excess in full was a cheque and a bill to the
  /// same person for the same move-out. Its own line in the letter.
  creditAppliedCents: Cents
  /// The part of the credit returned with the refund: whatever the excess
  /// deductions did not take. What `Deposit.creditRefundedCents` stores.
  creditRefundedCents: Cents
  /// What the tenant is actually paid: `refundedCents + creditRefundedCents`.
  totalRefundCents: Cents
}

/**
 * What happens to a held deposit once deductions and the tenant's own
 * ledger balance are both known.
 *
 * `appliedCents + refundedCents` always equals `heldCents` when nothing is
 * owed beyond it - the liability is zeroed exactly the way `Deposit`'s own
 * schema comment describes ("applied and refunded amounts account for the
 * rest"). A shortfall shows up as `additionalOwedCents`, never as a
 * negative `refundedCents`.
 *
 * A CREDIT BALANCE IS RETURNED, NOT CLAMPED AWAY (D-303). This used to treat
 * a negative ledger balance as zero, so a paid-up tenant who left mid-month
 * got the deposit back and lost the days they had paid for and not lived.
 *
 * AND IT MEETS DEDUCTIONS BEYOND THE DEPOSIT FIRST (D-307): only the
 * difference is refunded or invoiced, never both. The deposit's own
 * accounting is untouched by that - the credit is not deposit money
 * (Tex. Prop. Code §92.102 excludes "an advance payment of rent" from the
 * definition) and is set against a debt the deposit has already failed to
 * cover, not against the deposit. A credit and arrears cannot coexist: both
 * are the sign of one balance.
 */
export function computeDisposition(
  heldCents: Cents,
  deductedCents: Cents,
  outstandingLedgerCents: Cents,
): DispositionTotals {
  assertCents(heldCents, 'held')
  assertCents(deductedCents, 'deducted')
  assertCents(outstandingLedgerCents, 'outstanding ledger balance')

  const owedByTenant = Math.max(0, deductedCents) + Math.max(0, outstandingLedgerCents)
  const appliedCents = Math.min(heldCents, owedByTenant)
  const refundedCents = Math.max(0, heldCents - appliedCents)
  const ledgerAppliedCents = Math.min(appliedCents, Math.max(0, outstandingLedgerCents))
  const ledgerCreditCents = Math.max(0, -outstandingLedgerCents)
  // Deductions the deposit did not reach, before the credit meets them.
  const deductionsBeyondDepositCents =
    Math.max(0, deductedCents) - (appliedCents - ledgerAppliedCents)
  const creditAppliedCents = Math.min(ledgerCreditCents, deductionsBeyondDepositCents)
  const creditRefundedCents = ledgerCreditCents - creditAppliedCents
  const uncoveredDeductionsCents = deductionsBeyondDepositCents - creditAppliedCents
  const additionalOwedCents = Math.max(0, owedByTenant - heldCents) - creditAppliedCents

  return {
    heldCents,
    deductedCents,
    outstandingLedgerCents,
    appliedCents,
    ledgerAppliedCents,
    refundedCents,
    additionalOwedCents,
    uncoveredDeductionsCents,
    ledgerCreditCents,
    creditAppliedCents,
    creditRefundedCents,
    totalRefundCents: refundedCents + creditRefundedCents,
  }
}

/**
 * The totals AS THE LETTER STATED THEM, for a disposition already sent.
 *
 * What was promised is read back from the `Deposit` row and never recomputed
 * (D-305): the ledger moves after the letter - a late charge lands, the
 * applied credit comes off it at once (D-307) and the returned credit when
 * the refund is recorded (D-306) - and none of that may change the figure
 * the tenant was told or the one staff is asked to pay. `computed` supplies
 * only what no column holds.
 *
 * NOTHING IS STILL OWED BEYOND A DISPOSITION THAT PAYS MONEY BACK, by
 * construction: the deposit refunds only when it covered everything, and a
 * credit is returned only after it has covered the excess. So those two are
 * zeroed rather than recomputed, which matters - a recomputation against
 * what is left of the credit applies it to the same excess a second time.
 */
export function dispositionAsSent(
  computed: DispositionTotals,
  stored: {
    appliedCents: Cents
    refundedCents: Cents
    creditAppliedCents: Cents
    creditRefundedCents: Cents
  },
): DispositionTotals {
  const totalRefundCents = stored.refundedCents + stored.creditRefundedCents
  return {
    ...computed,
    appliedCents: stored.appliedCents,
    refundedCents: stored.refundedCents,
    ledgerCreditCents: stored.creditAppliedCents + stored.creditRefundedCents,
    creditAppliedCents: stored.creditAppliedCents,
    creditRefundedCents: stored.creditRefundedCents,
    totalRefundCents,
    ...(totalRefundCents > 0 ? { additionalOwedCents: 0, uncoveredDeductionsCents: 0 } : {}),
  }
}

export interface DepreciationGuidance {
  /// The most a claim this old, on an item with this useful life, is likely
  /// to hold up as - "full replacement cost on nine-year-old carpet loses
  /// in court" is exactly the case where `ageYears >= usefulLifeYears` and
  /// this comes back 0.
  suggestedMaxCents: Cents
  exceedsGuidance: boolean
}

/**
 * Straight-line proration - GUIDANCE, not a statutory number (D-4 does not
 * apply: no jurisdiction publishes a useful-life table this product could
 * read instead, so staff supplies both figures themselves per item, and
 * this only does the arithmetic on what they entered).
 *
 * `claimedCents` is whatever a deduction currently proposes to charge -
 * naturally, staff's first instinct is to type the full replacement or
 * repair cost, which is exactly the case this exists to catch. This
 * ALWAYS flags a nonzero claim on anything less than brand new (`ageYears
 * > 0`), because it is comparing that claim against a fraction of itself -
 * which is the point: the only way to clear the flag is to actually lower
 * the deduction to `suggestedMaxCents` or below, the same "advisory,
 * staff decides" posture the rest of this product takes with a warning
 * rather than a hard block (see `isFixableCondition`'s own sibling call in
 * `packages/core/inspections/comparison.ts`).
 */
export function depreciationGuidance(
  claimedCents: Cents,
  ageYears: number,
  usefulLifeYears: number,
): DepreciationGuidance {
  assertCents(claimedCents, 'claimed')
  const remainingFraction = usefulLifeYears <= 0 ? 0 : Math.max(0, 1 - ageYears / usefulLifeYears)
  const suggestedMaxCents = Math.round(claimedCents * remainingFraction)
  return { suggestedMaxCents, exceedsGuidance: claimedCents > suggestedMaxCents }
}

/**
 * "Unsupported" (INSP-03's own word) - derived, never stored. True only
 * when a deduction carries NONE of a work order, a move-out inspection
 * item, or an attached document - the three evidence paths INSP-03 names.
 */
export function isUnsupportedDeduction(facts: {
  workOrderId: string | null
  inspectionItemId: string | null
  evidenceDocumentCount: number
}): boolean {
  return (
    facts.workOrderId == null && facts.inspectionItemId == null && facts.evidenceDocumentCount === 0
  )
}

export interface DispositionLetterContext {
  tenantName: string
  addressLine1: string
  unitName: string
  /// Property-local, for rendering the date in the tenant's own time (D-3).
  timezone: string
  moveOutOn: Date
  deductions: readonly { description: string; amountCents: Cents }[]
  totals: DispositionTotals
}

/**
 * The disposition letter's own text.
 *
 * A DRAFT, same posture as every other generated legal artifact in this
 * product (D-4's closing line) - not reviewed by counsel, and it says so in
 * its own last line, the same as `nonRenewalNoticeText()`.
 */
export function dispositionLetterText(context: DispositionLetterContext): string {
  const moveOutDate = formatDate(context.moveOutOn, context.timezone)
  const { totals } = context

  const lines: (string | null)[] = [
    'Security deposit disposition',
    '',
    `Dear ${context.tenantName},`,
    '',
    `Your tenancy at ${context.addressLine1}${
      context.unitName ? ` (${context.unitName})` : ''
    } ended on ${moveOutDate}. This letter accounts for your security deposit of ${formatDollars(totals.heldCents)}.`,
    '',
  ]

  if (context.deductions.length > 0) {
    lines.push('Itemized deductions:')
    for (const deduction of context.deductions) {
      lines.push(`  - ${deduction.description}: ${formatDollars(deduction.amountCents)}`)
    }
    lines.push('')
  } else {
    lines.push('No deductions were made against your deposit.', '')
  }

  if (totals.outstandingLedgerCents > 0) {
    lines.push(
      `A separate outstanding balance of ${formatDollars(totals.outstandingLedgerCents)} on your account was also applied.`,
      '',
    )
  }

  // With a credit on the account as well, the deposit refund is named as
  // what it is and the credit and the total follow below - figures a tenant
  // can check line by line, rather than one they cannot.
  const credit = totals.ledgerCreditCents
  const creditApplied = totals.creditAppliedCents
  if (totals.refundedCents > 0) {
    lines.push(
      credit > 0
        ? `Refund of your security deposit: ${formatDollars(totals.refundedCents)}.`
        : `Amount being refunded to you: ${formatDollars(totals.refundedCents)}.`,
    )
  }
  // D-307: the credit meets what the deposit could not cover. Each step is
  // its own line - the excess, the credit, how much of it was applied - so
  // the figure that follows can be checked rather than taken on trust.
  if (creditApplied > 0) {
    lines.push(
      `Deductions beyond your security deposit: ${formatDollars(totals.uncoveredDeductionsCents + creditApplied)}.`,
      `Your account carries a credit balance of ${formatDollars(credit)} for rent paid beyond what was owed.`,
      `Credit applied to those deductions: ${formatDollars(creditApplied)}.`,
    )
  }
  if (totals.additionalOwedCents > 0) {
    lines.push(
      creditApplied > 0
        ? `After applying your full deposit and that credit, you still owe ${formatDollars(totals.additionalOwedCents)}. We will contact you separately about this balance.`
        : `After applying your full deposit, you still owe ${formatDollars(totals.additionalOwedCents)}. We will contact you separately about this balance.`,
    )
  }
  if (totals.refundedCents === 0 && totals.additionalOwedCents === 0) {
    lines.push(
      totals.creditRefundedCents > 0
        ? 'Your deposit has been fully applied and you owe nothing further.'
        : creditApplied > 0
          ? 'Your deposit and that credit have been fully applied; no refund is due and you owe nothing further.'
          : 'Your deposit has been fully applied; no refund is due and you owe nothing further.',
    )
  }
  if (totals.creditRefundedCents > 0) {
    lines.push(
      creditApplied > 0
        ? `Remainder of your credit balance being returned to you: ${formatDollars(totals.creditRefundedCents)}.`
        : `Your account also carries a credit balance of ${formatDollars(credit)} for rent paid beyond what was owed, which is being returned to you.`,
      `Total being refunded to you: ${formatDollars(totals.totalRefundCents)}.`,
    )
  }

  lines.push(
    '',
    '— This letter is a draft generated by the property management system and has not been reviewed by an attorney. It is not legal advice.',
  )

  return lines.filter((line) => line !== null).join('\n')
}

function formatDollars(cents: Cents): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(instant)
}

// ==========================================================================
// The refund is an EVENT (R-170).
//
// `finalizeDisposition` used to write `refundedCents` and a letter and stop,
// and all three readers of the deposit liability - the rent roll, the
// handoff file and the year-end tax packet - subtracted that promise as
// though the money had moved. So the moment the letter went out the deposit
// read as settled everywhere, while the tenant was still owed every cent of
// it. That is worse evidence than sending nothing, because it looks paid.
//
// Money the landlord KEEPS releases at the letter: `appliedCents` is the
// deduction and the arrears, and the disposition is the act that converts
// it. Money the landlord OWES BACK releases only when it is disbursed.
// ==========================================================================

export interface DepositBalanceFact {
  heldCents: Cents
  appliedCents: Cents
  refundedCents: Cents
  dispositionSentAt: Date | null
  refundPaidOn: Date | null
}

/**
 * What is still owed back to the tenant.
 *
 * `asOf` answers it as a BALANCE ON A DATE, which is the question the tax
 * packet asks and the only one that needs it: a deposit disposed of in March
 * 2027 was still held in full on 31 December 2026, and a refund cut in
 * March 2027 had not left the bank on that date either. Omit it and every
 * event counts, which is what a screen showing "now" wants.
 */
export function depositLiabilityCents(deposit: DepositBalanceFact, asOf?: Date): Cents {
  const happened = (at: Date | null) => at != null && (asOf == null || at <= asOf)
  const applied = happened(deposit.dispositionSentAt) ? deposit.appliedCents : 0
  const refunded = happened(deposit.refundPaidOn) ? deposit.refundedCents : 0
  return deposit.heldCents - applied - refunded
}

/// The ways a refund actually leaves. A subset of `PaymentChannel`, spelled
/// here rather than in the schema because the enum is shared with money
/// coming IN, where `RETAIL_CASH` and `HAP_ACH` mean something and here they
/// do not. Same shape as `OFFLINE_INSTRUMENTS` for money at the counter.
export const DEPOSIT_REFUND_INSTRUMENTS = {
  OFFLINE_CHECK: 'Check',
  ACH: 'Bank transfer (ACH)',
  MONEY_ORDER: 'Money order',
  OFFLINE_CASH: 'Cash',
} as const

export type DepositRefundInstrument = keyof typeof DEPOSIT_REFUND_INSTRUMENTS

export interface DepositRefundInput {
  method: string
  /// The day the money actually left, on the property's clock - frequently
  /// not today, for the same reason `OfflinePaymentInput.receivedOn` is not:
  /// a cheque written Friday and typed in on Monday was paid Friday, and it
  /// is the statutory deadline this date is measured against.
  paidOn: string
  /// Required for anything that carries one. A refund nobody can match back
  /// to a bank statement is the tenant's word against the owner's, which is
  /// exactly the dispute the evidence trail exists to settle.
  reference?: string | null
}

export interface DepositRefundViolation {
  field: string
  message: string
}

export function validateDepositRefund(
  input: DepositRefundInput,
  today: string,
): DepositRefundViolation[] {
  const violations: DepositRefundViolation[] = []

  if (!(input.method in DEPOSIT_REFUND_INSTRUMENTS)) {
    violations.push({ field: 'method', message: 'Choose how the refund was paid.' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) {
    violations.push({ field: 'paidOn', message: 'Enter the day the refund was paid.' })
  } else if (input.paidOn > today) {
    // String comparison is the correct one for YYYY-MM-DD and keeps this
    // pure - no zone may touch a calendar day (D-3).
    violations.push({ field: 'paidOn', message: 'A refund cannot be paid in the future.' })
  }
  if (input.method !== 'OFFLINE_CASH' && !input.reference?.trim()) {
    violations.push({
      field: 'reference',
      message: 'Enter the check number, trace or confirmation number.',
    })
  }

  return violations
}
