import 'server-only'

import {
  type Application,
  allocatePayment,
  allocationOrderFor,
} from '@rental/core/ledger'
import { businessDate, dueDateOnOrBefore } from '@rental/core/scheduling'
import { prisma, type Prisma } from '@rental/db'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'
import { leaseBalanceCents, outstandingCharges } from '@/lib/ledger/queries.ts'

// WHICH DEBT DID THIS PAYMENT PAY OFF? (PAY-03, D-4, D-12, R-035.)
//
// `allocatePayment` in packages/core has answered that since R-035 and had
// no caller in the product until this file - so the jurisdiction form has
// been collecting `paymentAllocationOrder` on every rule, validating it, and
// storing a number nothing read. What the projection did instead was settle
// every charge the invoice named IN FULL and give the leftover to rent,
// which is fee-before-rent under any order, including the RENT-first one
// Texas is seeded with.
//
// STRIPE EXECUTES, CORE DECIDES (D-12) IS NOT VIOLATED BY THIS. The
// projector still computes no amount: what moved is what Stripe says moved.
// It asks core how to SPLIT that amount across the debts on file, in the
// order the versioned rule states, and writes the answer down.
//
// THE RENT DEBT HAS NO `Charge` ROW, and leaving it out of the list is the
// whole bug rather than a simplification - ordinary rent is billed by the
// subscription and mints no charge (D-11/D-40), so a list of `Charge` rows
// is a list of everything EXCEPT the debt the order is mostly about. It is
// represented the way `delinquencyFor` already represents it (R-118, D-151):
// one debt, dated the most recent rent due day, sized at whatever part of
// the balance no charge row accounts for.

/// The sentinel id for the rent debt that has no `Charge` row. Never written
/// anywhere - `planAllocation` splits it back out before returning, and
/// anything it landed on becomes the unlinked entry.
const UNLINKED_RENT = '__unlinked_rent__'

export interface AllocationPlan {
  /// One per `Charge` row this payment pays down, in the order core chose.
  applications: Application[]
  /// What did not land on a charge row: the part that paid ordinary rent,
  /// plus any genuine overpayment. Written as a single unlinked entry, which
  /// is what "paid rent" looks like in this schema.
  unlinkedCents: number
}

/**
 * Plans one settled payment across the tenancy's debts.
 *
 * READ BEFORE THE ENTRIES IT PLANS ARE WRITTEN, deliberately: the balance
 * this works from must be the balance BEFORE this payment's own entries
 * exist, and every read here is of rows the projection is about to add to
 * rather than change.
 *
 * SERIALISED PER LEASE (MONEY-16, D-291). Two payments settling concurrently
 * used to each plan against the same balance and so both aim at the same
 * charge: the balance stayed right either way, but the linked rows against
 * one $100 fee could sum to $200. `webhook.ts` now takes a transaction-scoped
 * advisory lock on the lease and calls this inside it with `db` set to that
 * transaction, so the second plan reads the first one's committed rows. The
 * rule read stays on the pool: it is not what the lock protects.
 */
export async function planAllocation(
  args: {
    leaseId: string
    propertyId: string
    leasePayerId: string
    /// Positive cents, as they arrived.
    paymentCents: number
    /// When the money moved, per Stripe.
    occurredAt: Date
  },
  db: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<AllocationPlan> {
  const [charges, balanceBefore, payer] = await Promise.all([
    outstandingCharges(args.leaseId, db),
    leaseBalanceCents(args.leaseId, db),
    db.leasePayer.findUniqueOrThrow({
      where: { id: args.leasePayerId },
      select: {
        debitDay: true,
        lease: { select: { rentDueDay: true } },
        property: { select: { state: true, county: true, timezone: true } },
      },
    }),
  ])

  // NO CONFIGURED RULE FALLS BACK RATHER THAN REFUSING, which is the
  // opposite of what late fees and deposits do with a missing rule - and the
  // difference is that those DECLINE TO ACT while this one has already been
  // paid. Refusing here would mean refusing to project money that arrived.
  // `allocationOrderFor` supplies core's documented default, which is
  // RENT-first precisely because it is the reading least likely to leave
  // rent looking unpaid.
  const rule = await rulesForConfigured(
    { state: payer.property.state, county: payer.property.county },
    args.occurredAt,
  )
  const order = allocationOrderFor(rule ?? { paymentAllocationOrder: [] })

  // The part of the balance no `Charge` row accounts for. That is ordinary
  // rent (D-11/D-40) - and a credit balance makes it negative, which is a
  // real state and not a debt, so it floors at zero.
  const chargeTotal = charges.reduce((sum, charge) => sum + charge.outstandingCents, 0)
  const unlinkedRentCents = Math.max(0, balanceBefore - chargeTotal)

  // The payer's CHOSEN day when they have one, the lease's when they do not -
  // the same precedence `rent-roll.ts` and `predebit.ts` read.
  const today = businessDate(args.occurredAt, payer.property.timezone)
  const rentDueOn = dueDateOnOrBefore(today, payer.debitDay ?? payer.lease.rentDueDay)

  const debts =
    unlinkedRentCents > 0
      ? [
          ...charges,
          {
            id: UNLINKED_RENT,
            type: 'RENT',
            outstandingCents: unlinkedRentCents,
            dueOn: rentDueOn,
          },
        ]
      : charges

  const result = allocatePayment(args.paymentCents, debts, order)

  const applications = result.applications.filter((one) => one.chargeId !== UNLINKED_RENT)
  const toRent = result.applications
    .filter((one) => one.chargeId === UNLINKED_RENT)
    .reduce((sum, one) => sum + one.appliedCents, 0)

  // Rent plus any overpayment. `unappliedCents` is a credit on the account,
  // not an error - swallowing it would lose a tenant's money.
  return { applications, unlinkedCents: toRent + result.unappliedCents }
}
