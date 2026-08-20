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
  /// finalize time; a credit balance (negative) contributes nothing here.
  outstandingLedgerCents: Cents
  /// Kept against the liability - deductions plus any outstanding balance,
  /// never more than what was actually held.
  appliedCents: Cents
  /// Given back to the tenant.
  refundedCents: Cents
  /// What deductions and the outstanding balance together exceed the
  /// deposit by, if anything - money still owed AFTER the full deposit is
  /// applied. Disclosed in the letter; collecting it is a separate,
  /// deliberately out-of-scope concern (see this item's own PROGRESS entry).
  additionalOwedCents: Cents
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
  const additionalOwedCents = Math.max(0, owedByTenant - heldCents)

  return { heldCents, deductedCents, outstandingLedgerCents, appliedCents, refundedCents, additionalOwedCents }
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

  if (totals.refundedCents > 0) {
    lines.push(`Amount being refunded to you: ${formatDollars(totals.refundedCents)}.`)
  }
  if (totals.additionalOwedCents > 0) {
    lines.push(
      `After applying your full deposit, you still owe ${formatDollars(totals.additionalOwedCents)}. We will contact you separately about this balance.`,
    )
  }
  if (totals.refundedCents === 0 && totals.additionalOwedCents === 0) {
    lines.push('Your deposit has been fully applied; no refund is due and you owe nothing further.')
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
