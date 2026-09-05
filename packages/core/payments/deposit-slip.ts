// Undeposited offline payments, grouped into a deposit batch, and the
// printable slip that goes with them to the bank (PAY-05's own named
// leftover, R-166).
//
// ==========================================================================
// "BY DATE AND RECEIVER" IS THE GROUPING THE BACKLOG NAMED, AND IT IS ALSO A
// BUSINESS-DATE QUESTION, NOT A CALENDAR-TIMESTAMP ONE.
//
// A check received at 11pm property-local time and one received at 7am the
// next property-local morning are two different trips to the bank even if
// they land in the same UTC day, and the reverse is also true near a
// timezone boundary. `businessDate` is the caller's job (CLAUDE.md's
// `@db.Date`/BusinessDate rule) - this module takes it as a precomputed
// field rather than a Date, so it can never be tempted to read one out with
// the wrong zone.
//
// LEGAL ENTITY IS AN IMPLICIT BOUNDARY, NOT A GROUPING CHOICE. Two
// properties under the SAME entity can share a deposit slip - one trip, one
// bank account. Two under DIFFERENT entities cannot, because they are
// different bank accounts by definition (D-9's separate-entities design),
// and a slip that pretended otherwise would misdescribe money moving
// between LLCs that never actually happened. So the group key includes
// legalEntityId even though nobody asked for it by name - it is a
// constraint the real world imposes, not a partition this module invented.
// ==========================================================================

import type { Cents } from '../money/money.ts'

export interface UndepositedPayment {
  id: string
  amountCents: Cents
  channel: string
  checkNumber: string | null
  /// Property-local calendar day the payment was received, `YYYY-MM-DD`.
  receivedOn: string
  receivedByStaffId: string
  legalEntityId: string
}

export interface DepositGroup {
  receivedOn: string
  receivedByStaffId: string
  legalEntityId: string
  paymentIds: readonly string[]
  totalCents: Cents
}

/**
 * Every undeposited payment, grouped for one deposit trip apiece.
 *
 * Newest received-on first, so the group most likely to still be sitting in
 * a drawer leads - the whole point of this screen is to stop that pile
 * growing, and the oldest unmade deposit is buried at the bottom of a list
 * sorted the other way.
 */
export function groupForDeposit(
  payments: readonly UndepositedPayment[],
): DepositGroup[] {
  const groups = new Map<string, DepositGroup & { paymentIds: string[] }>()

  for (const payment of payments) {
    const key = `${payment.legalEntityId}|${payment.receivedOn}|${payment.receivedByStaffId}`
    const existing = groups.get(key)
    if (existing) {
      existing.paymentIds.push(payment.id)
      existing.totalCents += payment.amountCents
      continue
    }
    groups.set(key, {
      receivedOn: payment.receivedOn,
      receivedByStaffId: payment.receivedByStaffId,
      legalEntityId: payment.legalEntityId,
      paymentIds: [payment.id],
      totalCents: payment.amountCents,
    })
  }

  return [...groups.values()].sort((a, b) => (a.receivedOn < b.receivedOn ? 1 : -1))
}
