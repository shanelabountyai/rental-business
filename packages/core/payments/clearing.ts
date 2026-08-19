// When money handed over off the Stripe rails is safe to act on for a
// consequential, hard-to-reverse decision - not just "recorded" (PAY-05,
// INSP-01, R-069).
//
// `Payment.status === 'SETTLED'` already means "money received", not "money
// we're sure will stay". `offline.ts`'s own `recordOfflinePayment` comment
// says a personal check is SETTLED the instant staff takes it, because
// whether it clears the bank is a SEPARATE future event - a bounced check
// reverses through R-039's NSF path days or weeks later. For every other
// channel that gap does not exist: Stripe's PENDING -> SETTLED webhook
// already reflects ACH/card genuinely clearing, and cash/money order are
// certified funds with no bounce risk once in hand. `OFFLINE_CHECK` is the
// one channel where SETTLED and "safe to act on" are different moments.
//
// A plain literal, not a JurisdictionRule (D-4): how long a landlord holds
// an uncertified check before trusting it is business risk policy, not
// statute - no state law sets this number. Same posture as R-068's
// SIGNATURE_WINDOW_DAYS.
export const CHECK_HOLD_DAYS = 5

export interface ClearingFact {
  channel: string
  status: string
  receivedAt: Date
}

/**
 * Whether this payment can be trusted for something hard to take back, like
 * handing over keys. Certified funds and anything Stripe itself settled
 * clear the instant they SETTLE; an uncertified personal check needs its
 * hold to pass first.
 */
export function fundsCleared(payment: ClearingFact, asOf: Date): boolean {
  if (payment.status !== 'SETTLED') return false
  if (payment.channel !== 'OFFLINE_CHECK') return true
  const holdEndsAt = payment.receivedAt.getTime() + CHECK_HOLD_DAYS * 24 * 3_600_000
  return asOf.getTime() >= holdEndsAt
}
