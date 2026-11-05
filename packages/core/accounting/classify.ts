// Which journal fact one ledger entry is, on one basis (R-282a, D-393).
//
// The ledger's sign is the tenant's balance: a CHARGE is positive, a PAYMENT
// negative, a voided charge a negative REVERSAL and a returned or refunded
// payment a positive one (`webhook.ts`). So every row that CARRIES A PAYMENT
// is money moving - debit Undeposited Funds by the negated amount - and every
// other row is an obligation arising or being retracted - debit A/R by the
// amount. A negative amount swaps the sides in `buildJournalEntry`, which is
// how a reversal posts as a reversing line rather than an edit (Q4).
//
// CASH: only money moving is booked, credited straight to what it paid for.
// ACCRUAL: the obligation is booked to income when it arises, and the money
// clears A/R. Security deposits are a liability on both bases (Q7).
//
// The cash rule is the tax export's (`paymentId != null`, D-71), widened by
// one: a PAYMENT row whose `Payment` was never written still moved money,
// and reading it as an obligation would post it to income backwards.

import type { AccountKey, JournalFact } from './journal.ts'

export type SyncBasis = 'CASH' | 'ACCRUAL'

export type LedgerEntryKind = 'CHARGE' | 'PAYMENT' | 'CREDIT' | 'REVERSAL' | 'ADJUSTMENT'

export type ChargeKind =
  | 'RENT'
  | 'LATE_FEE'
  | 'NSF_FEE'
  | 'UTILITY'
  | 'RUBS_ALLOCATION'
  | 'PET_RENT'
  | 'PET_FEE'
  | 'DEPOSIT'
  | 'CHARGEBACK'
  | 'CONCESSION'
  | 'LEGAL_COST'
  | 'OTHER'

export interface SyncLedgerRow {
  id: string
  type: LedgerEntryKind
  amountCents: number
  paymentId: string | null
  /// The linked `Charge`'s type; null for the unlinked subscription rent row.
  chargeType: ChargeKind | null
}

/// `OTHER` is absent on purpose: it means nobody classified the charge, and
/// posting it to an income account would be a guess (D-71).
const CREDIT_ACCOUNT: Record<Exclude<ChargeKind, 'OTHER'>, AccountKey> = {
  RENT: 'RENTAL_INCOME',
  PET_RENT: 'RENTAL_INCOME',
  LATE_FEE: 'LATE_FEE_INCOME',
  NSF_FEE: 'FEE_INCOME',
  PET_FEE: 'FEE_INCOME',
  UTILITY: 'UTILITY_REIMBURSEMENTS',
  RUBS_ALLOCATION: 'UTILITY_REIMBURSEMENTS',
  DEPOSIT: 'SECURITY_DEPOSITS_HELD',
  CHARGEBACK: 'TENANT_CHARGEBACKS',
  CONCESSION: 'RENT_CONCESSIONS',
  LEGAL_COST: 'LEGAL_COST_RECOVERY',
}

export type Classification =
  | { kind: 'fact'; fact: JournalFact }
  /// Linked so it is not retried, with the reason, for the reconciliation
  /// page (R-283) to list. Never silently dropped.
  | { kind: 'excluded'; reason: string }
  /// Not an event on this basis (a charge on cash). Left unlinked.
  | { kind: 'not_on_basis' }

export const isMoneyMoving = (row: Pick<SyncLedgerRow, 'type' | 'paymentId'>) =>
  row.paymentId !== null || row.type === 'PAYMENT'

export function classifyLedgerEntry(row: SyncLedgerRow, basis: SyncBasis): Classification {
  if (row.type === 'ADJUSTMENT') {
    // D-306/D-307: ledger-only rows Stripe never saw, until D-308's credit note.
    return { kind: 'excluded', reason: 'A ledger-only adjustment (D-306, D-307) that Stripe never saw; book it by hand.' }
  }
  if (row.chargeType === 'OTHER') {
    return { kind: 'excluded', reason: 'A charge typed OTHER has no account; classify it and book it by hand.' }
  }
  const income = CREDIT_ACCOUNT[row.chargeType ?? 'RENT']
  if (isMoneyMoving(row)) {
    return {
      kind: 'fact',
      fact: {
        ledgerEntryId: row.id,
        debit: 'UNDEPOSITED_FUNDS',
        credit: basis === 'ACCRUAL' ? 'ACCOUNTS_RECEIVABLE' : income,
        amountCents: -row.amountCents,
      },
    }
  }
  if (basis === 'CASH') return { kind: 'not_on_basis' }
  return {
    kind: 'fact',
    fact: { ledgerEntryId: row.id, debit: 'ACCOUNTS_RECEIVABLE', credit: income, amountCents: row.amountCents },
  }
}

/// The fee Stripe kept from one payment (R-282b, PRD 09 Q8, D-398). It never
/// reached the bank, so it leaves Undeposited Funds for Merchant Fees, and the
/// day's net then matches the deposit. Not a ledger entry: it is carried on
/// the id of the payment's own entry in the same journal. Same on both bases,
/// because it is money that moved.
export function processingFeeFact(paymentLedgerEntryId: string, feeCents: number): JournalFact {
  return { ledgerEntryId: paymentLedgerEntryId, debit: 'MERCHANT_FEES', credit: 'UNDEPOSITED_FUNDS', amountCents: feeCents }
}
