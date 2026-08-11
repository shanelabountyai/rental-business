import 'server-only'

import { balanceCents, statement } from '@rental/core/ledger'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads over the ledger projection (PAY-03, D-11, R-035).
//
// EVERY NUMBER ON EVERY MONEY SCREEN COMES THROUGH HERE. D-11 makes
// `LedgerEntry` an append-only projection of Stripe, so a balance is a sum
// over rows rather than a maintained total on some other table - which is
// precisely what makes it checkable against Stripe at all (see
// lib/ledger/reconcile.ts). A cached balance column would be a second source
// of truth, and the whole point of D-11 is that there is one.

/// One lease's full statement, oldest first, with a running balance.
export async function leaseStatement(leaseId: string, scope: ResolvedScope) {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: { id: true, propertyId: true },
  })
  if (!lease || !scope.propertyIds.includes(lease.propertyId)) return null

  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId },
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      description: true,
      reversesId: true,
      stripeEventId: true,
    },
  })

  return {
    lines: statement(rows),
    balanceCents: balanceCents(rows),
  }
}

/// The balance alone, when a caller does not need the lines. Same rows, same
/// arithmetic - deliberately NOT a separate SQL SUM, so the two can never
/// disagree about what a balance is.
export async function leaseBalanceCents(leaseId: string): Promise<number> {
  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId },
    select: { id: true, amountCents: true },
  })
  return balanceCents(
    rows.map((row) => ({
      ...row,
      type: '',
      occurredAt: new Date(0),
      description: '',
    })),
  )
}

/// Charges with anything still unpaid, for the allocation policy to work
/// over. Outstanding is derived from the charge's own applications rather
/// than stored, for the same reason the balance is.
export async function outstandingCharges(leaseId: string) {
  const charges = await prisma.charge.findMany({
    where: { leaseId },
    select: {
      id: true,
      type: true,
      amountCents: true,
      dueOn: true,
      ledgerEntries: { select: { amountCents: true, type: true } },
    },
    orderBy: { dueOn: 'asc' },
  })

  return charges
    .map((charge) => {
      // Payments and credits against this charge are negative; the charge
      // itself is positive. What is left is the sum.
      const settled = charge.ledgerEntries
        .filter((entry) => entry.type !== 'CHARGE')
        .reduce((sum, entry) => sum + entry.amountCents, 0)
      return {
        id: charge.id,
        type: charge.type,
        // `settled` is negative, so adding it reduces the outstanding.
        outstandingCents: charge.amountCents + settled,
        dueOn: charge.dueOn.toISOString().slice(0, 10),
      }
    })
    .filter((charge) => charge.outstandingCents > 0)
}

/**
 * Fees on this lease that somebody could still waive (PAY-04, R-041).
 *
 * LATE_FEE and NSF_FEE only. Rent is not waivable — forgiving rent is a
 * concession, which is a different decision with different paperwork, and
 * offering it on the same control would blur the two.
 *
 * Returns waived fees as well as open ones, because the waiver record is
 * half the point: PAY-04's pattern report exists precisely so that who was
 * forgiven is visible, and a screen that hid past waivers would make an
 * operator's own history invisible to them at the moment they decide the
 * next one.
 */
export async function waivableFees(leaseId: string) {
  return prisma.charge.findMany({
    where: { leaseId, type: { in: ['LATE_FEE', 'NSF_FEE'] } },
    select: {
      id: true,
      type: true,
      amountCents: true,
      description: true,
      dueOn: true,
      waivedAt: true,
      waiveReason: true,
      waivedBy: { select: { name: true } },
    },
    orderBy: { dueOn: 'desc' },
  })
}
