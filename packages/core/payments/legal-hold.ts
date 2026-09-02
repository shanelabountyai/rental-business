import type { PaymentRail } from './collection.ts'

// Payment controls for a tenancy in legal action (PAY-12, R-047).
//
// ==========================================================================
// WHY THIS IS NOT AN ORDINARY SETTING.
//
// In many states, ACCEPTING A PARTIAL PAYMENT AFTER SERVING NOTICE VOIDS THE
// NOTICE. The eviction has to start again, and the tenancy has meanwhile been
// through a legal process for nothing. So the switches here are not
// preferences about how somebody likes to be paid — they are a control on
// money the owner must not receive, and a payment that slips through is a
// legal consequence rather than a bookkeeping one.
//
// THE ROW THAT DEFINES THIS ITEM NAMES THE DEFECT EXACTLY: "an autopay charge
// that fires the morning after a notice is served is a defect with legal
// consequences". That is why a hold is applied to Stripe SYNCHRONOUSLY and
// why the app refuses to report a hold as in force if Stripe did not accept
// it — see `applyPaymentHold` in the app layer.
//
// THREE SWITCHES, NOT ONE, because they are genuinely different postures:
//
//   blockOnline        Take nothing through the product at all. Stripe stops
//                      collecting AND the payment UI refuses. Both halves,
//                      because either alone leaves a path open.
//
//   blockPartial       Take the full balance or nothing. This is the one the
//                      "voided notice" problem is actually about: a tenant
//                      paying $50 of $1,500 after notice can be the act that
//                      restarts the whole process.
//
//   certifiedFundsOnly Take nothing that can bounce. A personal check or an
//                      ACH debit can be returned days later, by which point
//                      the notice may have been abandoned on the strength of
//                      a payment that never cleared.
//
// They compose. `certifiedFundsOnly` alone still permits a full payment by
// cashier's cheque recorded offline (PAY-05); `blockOnline` alone still
// permits staff to record one. Only the operator decides which apply.
// ==========================================================================

export interface PaymentHold {
  blockOnline: boolean
  blockPartial: boolean
  certifiedFundsOnly: boolean
}

export const NO_HOLD: PaymentHold = {
  blockOnline: false,
  blockPartial: false,
  certifiedFundsOnly: false,
}

/// Whether any switch is on. A hold with nothing set is not a hold, and the
/// difference matters for whether a reason is demanded and whether the
/// tenancy is shown as held.
export function holdIsActive(hold: PaymentHold): boolean {
  return hold.blockOnline || hold.blockPartial || hold.certifiedFundsOnly
}

export type HoldRefusal =
  /// Every online rail is closed — either outright, or because only
  /// certified funds are accepted and none of them are.
  | 'online_blocked'
  | 'certified_funds_only'
  /// A part payment on a tenancy where accepting one could void a notice.
  | 'partial_blocked'

/**
 * Whether a payment of `amountCents` may be taken through the product.
 *
 * `owedCents` is what the payer may be asked for right now — `payable()`'s
 * `maxCents`, already net of money in flight. Compared rather than trusted:
 * "full balance" has to mean the balance at the moment of payment, not the
 * one a screen was rendered with.
 *
 * ORDER MATTERS. `blockOnline` is reported before `certifiedFundsOnly`,
 * which is reported before `partial_blocked`, because that is the order of
 * how completely each closes the door: a tenant told "we cannot take a part
 * payment" would reasonably try the full amount, and on a blocked tenancy
 * that is a second refusal they should not have been invited into.
 */
export function holdRefusal(
  hold: PaymentHold,
  amountCents: number,
  owedCents: number,
): HoldRefusal | null {
  if (hold.blockOnline) return 'online_blocked'
  if (hold.certifiedFundsOnly) return 'certified_funds_only'
  if (hold.blockPartial && amountCents < owedCents) return 'partial_blocked'
  return null
}

/**
 * What the tenant is told.
 *
 * ==========================================================================
 * NEUTRAL, AND PAY-12 SAYS SO IN THOSE WORDS: "refused with a neutral
 * message". None of these mention eviction, notice, legal action or a court,
 * for two reasons that both matter.
 *
 * A payment screen is the wrong place to learn you are being evicted — the
 * notice itself is the instrument that says so, served the way the statute
 * requires, and a web page pre-empting it is neither reliable nor lawful
 * service.
 *
 * And the screen may be read by somebody who is not the tenant. A phone is
 * handed around; a household includes people who are not party to the case.
 * Announcing a legal action to whoever is holding the device is a disclosure
 * nobody authorised.
 *
 * So every message says the same true thing — we cannot take this here —
 * and points at a person.
 * ==========================================================================
 */
export function holdMessage(refusal: HoldRefusal): string {
  switch (refusal) {
    case 'online_blocked':
      return 'Online payments are not available on this account. Please contact the office.'
    case 'certified_funds_only':
      return 'This account can only be paid by cashier’s cheque or money order. Please contact the office to arrange it.'
    case 'partial_blocked':
      return 'Part payments are not being accepted on this account. Please contact the office.'
  }
}
