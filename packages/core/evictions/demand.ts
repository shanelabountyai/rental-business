// What a cure notice demanded, and whether the tenant paid it (R-194).
//
// Before this item `Notice` held no amount at all, so the one question that
// has to be right before a filing fee is spent - did they pay what we
// demanded, in full, inside the cure period? - was answered by eye from two
// numbers in different places. The demand is now computed HERE, at the moment
// the notice is drafted, and stored on the row it belongs to. `Notice` is
// append-only (R-161), so the figure a verdict is read against can never move
// after the tenant has been handed it.
//
// Two questions in here are state law, and neither is answered by code:
//   - may a cure notice demand fees as well as rent?
//     (`JurisdictionRule.cureDemandMayIncludeFees`)
//   - does a partial payment inside the cure period cure?
//     (`JurisdictionRule.partialPaymentCures`)
// Both are three-valued like `acceptanceWaivesNotice` (D-48): null means
// nobody has told us, and the product warns rather than answering for the
// state.

import { allocateBalance } from '../ledger/aging.ts'
import { type Cents, formatCents } from '../money/money.ts'
import { type BusinessDate, friendlyBusinessDate } from '../scheduling/local-time.ts'
import type { CureClockState, CurePayment } from './cure.ts'

/// Rent, or anything else. A statute that limits a cure demand limits it to
/// RENT, so this is the only distinction the demand draws.
export type DemandKind = 'RENT' | 'FEE'

/// The `ChargeType`s that are rent. Everything else - late and NSF fees,
/// utilities, chargebacks, legal costs - is a fee for this purpose, which is
/// the cautious reading: a notice demanding more than a rent-only state
/// allows can be void, and one demanding less is merely short.
const RENT_CHARGE_TYPES: readonly string[] = ['RENT', 'PET_RENT']

export function demandKind(chargeType: string): DemandKind {
  return RENT_CHARGE_TYPES.includes(chargeType) ? 'RENT' : 'FEE'
}

/// A debt the balance may be sitting on: a charge row, or the current
/// period's rent, which mints no `Charge` (D-11/D-40).
export interface DemandDebt {
  dueOn: BusinessDate
  amountCents: Cents
  label: string
  kind: DemandKind
}

/// One line of a stored demand. `demanded: false` is a fee the state's rule
/// kept out of the total - listed anyway, so the record shows what was owed
/// and what was deliberately not asked for.
export interface DemandLine {
  label: string
  /// Null for balance no dated debt accounts for.
  dueOn: BusinessDate | null
  kind: DemandKind
  amountCents: Cents
  demanded: boolean
}

export interface CureDemand {
  demandedCents: Cents
  /// Oldest first, the order a tenant reads a statement in.
  lines: DemandLine[]
}

/**
 * What a cure notice drafted today should demand.
 *
 * The balance is allocated by `allocateBalance` - the SAME allocation the
 * aging uses - so a notice can never demand a debt the rent roll considers
 * paid. Balance no dated debt accounts for is unlinked rent from a period
 * this schema does not record (the `nearestRentDueOn` limit in `aging.ts`),
 * and is demanded as rent.
 *
 * `mayIncludeFees` null INCLUDES the fees and the caller warns. That is the
 * owner's decision (D-209): leaving them out would be the product deciding
 * the state is rent-only, and the warning is what puts the question in front
 * of the attorney.
 */
export function cureDemand(facts: {
  balanceCents: Cents
  debts: readonly DemandDebt[]
  mayIncludeFees: boolean | null
}): CureDemand {
  if (facts.balanceCents <= 0) return { demandedCents: 0, lines: [] }

  const { owed, unallocatedCents } = allocateBalance(facts.debts, facts.balanceCents)
  const lines: DemandLine[] = owed.map(({ debt, owedCents }) => ({
    label: debt.label,
    dueOn: debt.dueOn,
    kind: debt.kind,
    amountCents: owedCents,
    demanded: debt.kind === 'RENT' || facts.mayIncludeFees !== false,
  }))
  if (unallocatedCents > 0) {
    lines.push({
      label: 'Rent from earlier periods',
      dueOn: null,
      kind: 'RENT',
      amountCents: unallocatedCents,
      demanded: true,
    })
  }
  lines.reverse()

  return {
    demandedCents: lines.filter((line) => line.demanded).reduce((sum, line) => sum + line.amountCents, 0),
    lines,
  }
}

/// The sentence beside a demand about fees, or null when counsel has said
/// fees may be demanded.
export function feeDemandWarning(mayIncludeFees: boolean | null): string | null {
  if (mayIncludeFees === true) return null
  if (mayIncludeFees === false) {
    return 'This state’s configured rule says a cure notice may demand rent only, so fees and other charges are listed but not demanded.'
  }
  return 'Whether a cure notice may demand fees as well as rent is state law this product has not been taught. Fees are included; a notice that demands more than the law allows can be void. Ask your attorney before serving it.'
}

export function demandLineText(line: DemandLine): string {
  return line.dueOn ? `${line.label}, due ${friendlyBusinessDate(line.dueOn)}` : line.label
}

/**
 * The notice's own text. A DRAFT, the same posture as every other generated
 * legal artifact here (D-4) - not reviewed by counsel, and it says so.
 */
export function cureNoticeText(context: {
  title: string
  tenantNames: readonly string[]
  addressLine1: string
  unitName: string | null
  demand: CureDemand
  payOrQuitDays: number | null
}): string {
  const demanded = context.demand.lines.filter((line) => line.demanded)
  return [
    context.title,
    '',
    `To: ${context.tenantNames.join(', ') || 'All occupants'}`,
    `Premises: ${context.addressLine1}${context.unitName ? ` (${context.unitName})` : ''}`,
    '',
    'The following is past due under your lease:',
    ...demanded.map((line) => `  ${demandLineText(line)}: ${formatCents(line.amountCents)}`),
    `Total demanded: ${formatCents(context.demand.demandedCents)}`,
    '',
    context.payOrQuitDays != null
      ? `To avoid further action, pay the total demanded in full within ${context.payOrQuitDays} days after this notice is served, or vacate the premises.`
      : 'To avoid further action, pay the total demanded in full within the period your jurisdiction allows after this notice is served, or vacate the premises.',
    '',
    '— This notice is a draft generated by the property management system and has not been reviewed by an attorney. It is not legal advice.',
  ].join('\n')
}

export type CureVerdictState = 'demand_not_recorded' | 'cured' | 'part_cured' | 'not_cured'

export interface CureVerdict {
  state: CureVerdictState
  demandedCents: Cents | null
  keptCents: Cents
  /// Whether the window closed at a configured last day to cure. False means
  /// no cure period is configured, and every payment since drafting counted.
  windowEndsAtCureBy: boolean
}

/**
 * Whether the tenant paid what the notice demanded.
 *
 * Counts payments KEPT (the caller passes only unreversed PENDING/SETTLED
 * rows, R-156's definition) from the day the notice was DRAFTED, not the day
 * it was served: the demand was the balance on the drafting day, so a
 * payment between drafting and service reduced exactly that debt. Counting
 * from drafting can only over-credit the tenant - the cheap direction, since
 * the verdict exists to stop a filing on a notice that was already paid.
 * A payment after the last day to cure is not a cure; it still appears in
 * the acceptance band, which is a different question.
 *
 * A WARNING, NEVER A BLOCKER - `readyToFile` does not read this, the line
 * R-156 drew for acceptance. Whether a cured notice can still be filed on is
 * the attorney's call, and this arithmetic can over-credit.
 */
export function cureVerdict(
  demandedCents: Cents | null,
  payments: readonly CurePayment[],
  draftedOn: BusinessDate,
  cureBy: BusinessDate | null,
): CureVerdict {
  const windowEndsAtCureBy = cureBy != null
  if (demandedCents == null) {
    return { state: 'demand_not_recorded', demandedCents, keptCents: 0, windowEndsAtCureBy }
  }
  const keptCents = payments
    .filter((p) => p.receivedOn >= draftedOn && (cureBy == null || p.receivedOn <= cureBy))
    .reduce((sum, p) => sum + p.amountCents, 0)
  const state = keptCents >= demandedCents ? 'cured' : keptCents > 0 ? 'part_cured' : 'not_cured'
  return { state, demandedCents, keptCents, windowEndsAtCureBy }
}

/// The verdict as one sentence. `clockState` says whether the answer is final
/// yet: while the cure period runs, "not cured" is only "not yet".
export function cureVerdictSentence(verdict: CureVerdict, clockState: CureClockState): string {
  if (verdict.state === 'demand_not_recorded' || verdict.demandedCents == null) {
    return 'This notice was created before the product recorded what a notice demanded, so whether the tenant cured cannot be worked out here. Read the notice itself.'
  }
  const demanded = formatCents(verdict.demandedCents)
  const kept = formatCents(verdict.keptCents)
  const window = verdict.windowEndsAtCureBy
    ? 'between drafting and the last day to cure'
    : 'since drafting — no cure period is configured, so every payment since then counts'
  const soFar = clockState === 'expired' ? '' : ' so far'

  if (verdict.state === 'cured') return `Cured: ${kept} kept against ${demanded} demanded, ${window}.`
  if (verdict.state === 'part_cured') {
    return `Part-cured${soFar}: ${kept} of ${demanded} kept ${window}, ${formatCents(verdict.demandedCents - verdict.keptCents)} short.`
  }
  return clockState === 'expired'
    ? `Not cured: nothing kept against ${demanded} demanded ${window}.`
    : `Not cured yet: nothing kept against ${demanded} demanded so far.`
}

/// What a partial payment means here, per the configured rule. Shown only
/// beside a part-cured verdict.
export function partialCureWarning(partialPaymentCures: boolean | null): string {
  if (partialPaymentCures === true) {
    return 'This state’s configured rule says a partial payment inside the cure period cures the notice. Ask your attorney before filing on it.'
  }
  if (partialPaymentCures === false) {
    return 'This state’s configured rule says only payment in full cures. Keeping the partial payment may still have waived the notice — see the acceptance warning.'
  }
  return 'Whether a partial payment cures the notice is state law this product has not been taught. Ask your attorney before filing on this notice.'
}
