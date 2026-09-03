import type { BusinessDate } from '../scheduling/local-time.ts'

// Money that arrives off the rails (PAY-05, R-038).
//
// A tenant hands over a check, a money order, or notes at the office. Stripe
// never sees it, and that is the whole problem this module exists inside.
//
// WHY IT STILL HAS TO REACH STRIPE. D-11 makes Stripe the system of record
// for money, but the reason here is not architectural tidiness - it is that
// STRIPE IS DRIVING COLLECTION. A payer on `charge_automatically` will be
// debited again on the billing day; one on `send_invoice` keeps an open
// invoice and keeps being dunned. A check recorded only in our own ledger
// means a tenant who paid gets chased for the same rent, and eventually
// double-debited. So an offline payment is pushed to Stripe as an
// out-of-band payment against the open invoice, Stripe stops collecting, and
// the ledger moves through the same webhook path as every other payment.
//
// WHAT STAYS OURS. `checkNumber` and `receivedByStaffId` are facts Stripe
// cannot hold and has no opinion about: which numbered instrument arrived,
// and which member of staff took it. PAY-05 is explicit that a cash payment
// with no named recipient is an unauditable cash payment. Those live on our
// `Payment` row, which R-002 designed for exactly this - the ledger stays a
// pure projection, and the operational detail hangs beside it.

/// The channels a human hands over. Deliberately the same names as the
/// `PaymentChannel` enum so the two cannot drift, and deliberately NOT
/// `RETAIL_CASH` - that is a third-party network posting electronically
/// (R-037a), not somebody at a counter.
export const OFFLINE_CHANNELS = ['OFFLINE_CHECK', 'MONEY_ORDER', 'OFFLINE_CASH'] as const
export type OfflineChannel = (typeof OFFLINE_CHANNELS)[number]

const OFFLINE_SET: ReadonlySet<string> = new Set(OFFLINE_CHANNELS)

/// What to call the instrument on Stripe's own payment record (R-038a).
/// Stripe shows this to anybody reading the dashboard, so it is the human
/// words rather than the enum - a check adds its number at the call site.
export const OFFLINE_INSTRUMENTS: Record<OfflineChannel, string> = {
  OFFLINE_CHECK: 'Check',
  MONEY_ORDER: 'Money order',
  OFFLINE_CASH: 'Cash',
}

export function isOfflineChannel(value: string): value is OfflineChannel {
  return OFFLINE_SET.has(value)
}

export interface OfflinePaymentInput {
  channel: string
  amountCents: number
  /// The day the money actually changed hands, on the property's clock -
  /// which is frequently NOT today. A check handed over on Friday and
  /// recorded on Monday was paid on Friday, and late-fee arithmetic runs off
  /// the date it arrived, not the date somebody found time to type it in.
  receivedOn: BusinessDate
  /// Required for a check. The number is how a bounced instrument is matched
  /// back to the record months later.
  checkNumber?: string | null
  /// Who took it. Never optional for an offline payment - see PAY-05.
  receivedByStaffId?: string | null
}

export interface Violation {
  field: string
  message: string
}

/**
 * Whether this is a well-formed record of money somebody handed over.
 *
 * Shape only. Whether the amount is one we can actually apply is
 * `offlinePaymentDecision()` below, because that needs the balance and the
 * open invoice and this needs neither.
 */
export function validateOfflinePayment(
  input: OfflinePaymentInput,
  today: BusinessDate,
): Violation[] {
  const violations: Violation[] = []

  if (!isOfflineChannel(input.channel)) {
    violations.push({ field: 'channel', message: 'Choose how the payment arrived.' })
  }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    violations.push({ field: 'amountDollars', message: 'Enter how much was handed over.' })
  }

  if (!input.receivedOn) {
    violations.push({ field: 'receivedOn', message: 'When did this arrive?' })
  } else if (input.receivedOn > today) {
    // A post-dated check is a real thing, and recording it as RECEIVED today
    // would credit money nobody has. It is recorded on the day it is
    // deposited, not the day it was written.
    violations.push({
      field: 'receivedOn',
      message: 'That date is in the future. Record it on the day the money actually arrives.',
    })
  }

  if (input.channel === 'OFFLINE_CHECK' && !input.checkNumber?.trim()) {
    violations.push({
      field: 'checkNumber',
      message: 'A check needs its number — it is how a returned check is matched back later.',
    })
  }

  if (!input.receivedByStaffId) {
    // Not a form field anybody fills in; it comes from the session. A
    // violation here means a caller forgot to pass it, which must fail
    // loudly rather than write an unattributable cash payment.
    violations.push({ field: 'receivedByStaffId', message: 'Nobody is recorded as receiving this.' })
  }

  return violations
}

export type OfflineRefusal =
  /// Nothing is owed, so there is nothing to apply this to.
  | 'nothing_owed'
  /// More than the balance. Prepayment has to be allocated somewhere and the
  /// allocation order is jurisdiction configuration - the same reason the
  /// tenant-facing flow refuses an overpayment.
  | 'more_than_owed'
  /// No issued invoice to apply this to. Offline money is attached to an
  /// INVOICE; without one there is nothing to attach it to, and crediting
  /// the customer balance instead applies to the NEXT invoice rather than
  /// the debt in front of us - measured, not assumed (R-038a): a credit
  /// posted against an open invoice leaves `amount_remaining` untouched.
  | 'no_open_invoice'
  /// More than the invoice in front of us still asks for. LESS is fine now
  /// (R-038a) - a part-payment is attached and the invoice stays open. More
  /// is not: Stripe itself refuses to attach a payment larger than the
  /// remainder, and the surplus belongs to a period that has not been billed
  /// yet, where allocation order is jurisdiction configuration.
  | 'more_than_invoiced'
  /// A part-payment on a tenancy the operator has put a hold on (PAY-12).
  /// NEW WITH R-038a AND NOT OPTIONAL: R-038 could not take a part-payment
  /// at all, so `blockPartial` was satisfied by accident. Making them
  /// possible offline without checking the switch would reopen exactly the
  /// hazard the switch exists for - in many states accepting a partial
  /// after serving notice can void the eviction, and the counter is where
  /// that happens.
  | 'partial_blocked'
  /// An instrument that can bounce or be disputed, on a tenancy set to take
  /// certified funds only (PAY-12). A personal check can be returned days
  /// after a notice was abandoned on the strength of it; cash is refused
  /// because the switch's point is a bank-guaranteed, traceable instrument.
  /// R-038a's recorded gap - the switch existed and the counter never read
  /// it (R-155).
  | 'not_certified_funds'

export interface OfflineFacts {
  balanceCents: number
  /// The operator's PAY-12 switch: take the full balance or nothing.
  blockPartial: boolean
  /// The operator's other PAY-12 switch: take nothing that can bounce.
  certifiedFundsOnly: boolean
  /// The instrument in hand. In the facts rather than a separate argument
  /// because the decision is about WHAT arrived, not only how much.
  channel: OfflineChannel
  /// What Stripe says is still owed on issued invoices. Null means we could
  /// not ask, which refuses - the same rule the collection-method switch
  /// follows, and for the same reason.
  openInvoiceAmountCents: number | null
}

export interface OfflineDecision {
  allowed: boolean
  refusal?: OfflineRefusal
}

/**
 * Whether this amount can be applied to what is actually outstanding.
 *
 * ORDERED so the message names the most useful fact. "You owe nothing"
 * before "that is too much", because a staff member typing into the wrong
 * tenant's record needs to hear the first one.
 */
export function offlinePaymentDecision(
  facts: OfflineFacts,
  amountCents: number,
): OfflineDecision {
  if (facts.balanceCents <= 0) return { allowed: false, refusal: 'nothing_owed' }
  if (amountCents > facts.balanceCents) return { allowed: false, refusal: 'more_than_owed' }
  if (facts.openInvoiceAmountCents == null || facts.openInvoiceAmountCents <= 0) {
    return { allowed: false, refusal: 'no_open_invoice' }
  }
  if (amountCents > facts.openInvoiceAmountCents) {
    return { allowed: false, refusal: 'more_than_invoiced' }
  }
  // The policy refusals come after the arithmetic ones - a staff member
  // should hear "that is the wrong tenant" or "that is more than is owed"
  // first. Between the two policies, the instrument before the amount,
  // following `holdRefusal`'s ordering rule: certified-funds closes the door
  // on the thing in the payer's hand, and hearing about the part-payment
  // rule first would invite a second refusal after they swap instruments.
  if (facts.certifiedFundsOnly && facts.channel !== 'MONEY_ORDER') {
    return { allowed: false, refusal: 'not_certified_funds' }
  }
  //
  // Compared against the BALANCE, not the open invoice: `blockPartial`'s own
  // words are "take the full balance or nothing", and a tenancy two periods
  // behind can settle one invoice in full while still owing.
  if (facts.blockPartial && amountCents < facts.balanceCents) {
    return { allowed: false, refusal: 'partial_blocked' }
  }
  return { allowed: true }
}

/// Sentences for STAFF, and each says what to do instead. The partial one
/// names the real constraint rather than hiding behind "not supported":
/// somebody standing at a counter with half the rent in cash needs to know
/// whether to take it.
export const OFFLINE_REFUSALS: Record<OfflineRefusal, string> = {
  nothing_owed:
    'This tenant owes nothing right now. Check you have the right lease before recording anything.',
  more_than_owed:
    'That is more than the balance. Record what is owed, and handle any overpayment as a separate credit.',
  no_open_invoice:
    'There is no issued invoice to apply this to yet. Once this period is billed, record it against that.',
  more_than_invoiced:
    'That is more than the current invoice still asks for. Record what this invoice covers; anything beyond it belongs to a period that has not been billed yet.',
  // Says what to do, and does NOT say why - PAY-12's neutrality rule applies
  // to the staff-facing sentence too, because this one gets read aloud to
  // the person standing at the counter.
  partial_blocked:
    'This tenancy is set to accept the full balance or nothing. Record the full amount, or lift the hold first if that is the intention.',
  // "Record either as a money order" because that is the certified-paper
  // channel this form has: a cashier's cheque is bank-guaranteed exactly as
  // a money order is, and the tenant-facing hold message already invites
  // both instruments.
  not_certified_funds:
    'This tenancy is set to take certified funds only. Accept a cashier’s cheque or money order — record either as a money order — or lift the hold first if that is the intention.',
}
