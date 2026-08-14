import { type Cents, formatCents } from '../money/money.ts'
import type { BusinessDate } from '../scheduling/local-time.ts'

// Recurring charges beside the rent (PAY-08, R-042). Pure - no database, no SDK.
//
// Pet rent and a flat utility fee are the two the backlog names, and they are
// the same shape: an agreed amount, every month, for as long as the fact that
// produced it holds. They are SUBSCRIPTION ITEMS rather than invoice items,
// which is the one structural difference from every other push this product
// makes - a late fee, an NSF fee and a proration are each a single event, and
// these are terms of the tenancy.
//
// WHY STRIPE MAY OWN THE REPETITION HERE, WHEN D-12 SAYS IT MAY NOT OWN THE
// AMOUNT. D-12's line is about statutes: if a rule could change a number,
// core computes it. Nothing in any statute touches $35 of agreed pet rent -
// it is a term of the contract, exactly like the rent itself, and the rent
// has been a Stripe subscription since R-034. A flat utility fee is the same.
// The moment an amount stops being flat - RUBS, where the bill differs every
// month - it stops being a subscription item and becomes a computed invoice
// item, which is why `rubs.ts` is a separate file rather than a method here.
//
// No `Charge` row is written for these, deliberately. The projection already
// handles a subscription line with no charge behind it: it lands in the
// remainder entry alongside the rent (see webhook.ts's "one entry per charge
// we raised"). Minting monthly Charge rows to mirror what Stripe is already
// billing would be a second schedule to keep in sync with the first.

/**
 * The charge types that may recur.
 *
 * Deliberately two. Every other `ChargeType` is either an event (a late fee,
 * an NSF fee, a chargeback) or a variable monthly amount that is not flat and
 * therefore is not a subscription item - `RUBS_ALLOCATION` most of all. A
 * list that admitted `LATE_FEE` would let somebody bill a late fee every
 * month for ever with no statute ever consulted.
 */
export const RECURRING_CHARGE_TYPES = ['PET_RENT', 'UTILITY'] as const
export type RecurringChargeType = (typeof RECURRING_CHARGE_TYPES)[number]

export function isRecurringChargeType(value: string): value is RecurringChargeType {
  return (RECURRING_CHARGE_TYPES as readonly string[]).includes(value)
}

export interface RecurringChargeInput {
  type: string
  amountCents: number
  /// Free text naming the fact - "Two cats", "Trash - flat monthly". Goes on
  /// the invoice line the tenant reads.
  label: string
  startsOn: BusinessDate
  endsOn?: BusinessDate | null
}

export type RecurringChargeDecision =
  | { ok: true; type: RecurringChargeType; description: string }
  | { ok: false; field: 'type' | 'amountCents' | 'label' | 'endsOn'; error: string }

/**
 * Whether this is a recurring charge the product will bill, and what the
 * tenant will see if so.
 *
 * Refuses rather than clamps. Every other money rule in core clamps to a
 * statutory ceiling because a statute exists to clamp to; there is no statute
 * on agreed pet rent, so the only defensible answer to a nonsensical input is
 * to decline it and say which field was wrong.
 */
export function validateRecurringCharge(
  input: RecurringChargeInput,
): RecurringChargeDecision {
  if (!isRecurringChargeType(input.type)) {
    return {
      ok: false,
      field: 'type',
      error: 'Only pet rent and a flat utility fee can be billed every month.',
    }
  }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    // Zero is refused as well as negative. A zero-amount subscription item
    // bills a line reading $0.00 on every invoice for the rest of the
    // tenancy, which is a question somebody has to answer every month.
    return {
      ok: false,
      field: 'amountCents',
      error: 'Enter an amount above zero.',
    }
  }

  const label = input.label.trim()
  if (!label) {
    // The label IS the evidence. "Pet rent $35" on a tenant's invoice for
    // three years, with nothing saying which pet was agreed to, is the
    // dispute this field exists to prevent.
    return {
      ok: false,
      field: 'label',
      error: 'Say what this is for — "Two cats", or "Trash, flat monthly".',
    }
  }

  if (input.endsOn && input.endsOn <= input.startsOn) {
    // BusinessDates are `YYYY-MM-DD` strings, so this comparison is
    // lexicographic and correct - and cannot be misread through a timezone,
    // which is the whole reason the type exists.
    return {
      ok: false,
      field: 'endsOn',
      error: 'The end date has to be after the start date.',
    }
  }

  return {
    ok: true,
    type: input.type,
    description: describeRecurringCharge({
      type: input.type,
      amountCents: input.amountCents,
      label,
    }),
  }
}

const TYPE_WORDS: Record<RecurringChargeType, string> = {
  PET_RENT: 'Pet rent',
  UTILITY: 'Utility',
}

/**
 * The invoice line, in words.
 *
 * Same reasoning as `describeProration`: a tenant who can see "Pet rent — Two
 * cats — $35.00/month" knows what they agreed to and can say so if they did
 * not. "Pet rent" alone has to be taken on trust.
 */
export function describeRecurringCharge(input: {
  type: RecurringChargeType
  amountCents: Cents
  label: string
}): string {
  return `${TYPE_WORDS[input.type]} — ${input.label.trim()} — ${formatCents(input.amountCents)}/month`
}
