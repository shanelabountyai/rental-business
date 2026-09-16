import 'server-only'

import { agingTotals } from '@rental/core/ledger'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { type RentRollRow, rentRoll } from '@/lib/payments/rent-roll.ts'
import type { ResolvedScope } from '@/lib/scope/types.ts'

// Money owed by tenants who have moved out (R-215, PAY-06/PAY-11/RPT-02).
//
// The rent roll reads live tenancies only, so the day a lease ended its
// balance left every list an operator reads - usually the largest receivable
// a small portfolio books. This is the same arithmetic over ENDED and
// TERMINATED leases, plus the two things only a former tenancy has: damage
// the deposit could not cover that has not reached the ledger yet, and the
// owner's decision to stop pursuing it (D-233).

export const FORMER_LEASE_STATUSES = ['ENDED', 'TERMINATED'] as const

export interface FormerTenantRow extends RentRollRow {
  /// A disposition's uncovered-deductions charge the provider has not billed
  /// yet (R-215). Owed, but not on the ledger, so not in `balanceCents`.
  unbilledCents: number
  /// What the tenant owes: the ledger balance plus anything unbilled.
  owedCents: number
  writeOff: { amountCents: number; writtenOffOn: string; reason: string } | null
}

export async function formerTenantReceivables(scope: Pick<ResolvedScope, 'propertyIds'>) {
  const roll = await rentRoll(scope, undefined, FORMER_LEASE_STATUSES)
  const leaseIds = roll.rows.map((row) => row.leaseId)

  const [unbilled, writeOffs] = await Promise.all([
    // "Unbilled" is decided by the ledger, not by `stripeInvoiceId`: in
    // production the projection can land before that column is written, and
    // counting the charge twice in that window would overstate the debt.
    prisma.charge.findMany({
      where: {
        leaseId: { in: leaseIds },
        depositId: { not: null },
        waivedAt: null,
        ledgerEntries: { none: {} },
      },
      select: { leaseId: true, amountCents: true },
    }),
    prisma.receivableWriteOff.findMany({
      where: { leaseId: { in: leaseIds } },
      orderBy: { createdAt: 'desc' },
      select: { leaseId: true, amountCents: true, writtenOffOn: true, reason: true },
    }),
  ])

  const unbilledByLease = new Map<string, number>()
  for (const charge of unbilled) {
    unbilledByLease.set(charge.leaseId, (unbilledByLease.get(charge.leaseId) ?? 0) + charge.amountCents)
  }
  const writeOffByLease = new Map<string, FormerTenantRow['writeOff']>()
  for (const row of writeOffs) {
    // Newest first, so the first seen is the latest decision.
    if (!writeOffByLease.has(row.leaseId)) {
      writeOffByLease.set(row.leaseId, {
        amountCents: row.amountCents,
        writtenOffOn: utcToBusinessDate(row.writtenOffOn),
        reason: row.reason,
      })
    }
  }

  const rows: FormerTenantRow[] = roll.rows
    .map((row) => {
      const unbilledCents = unbilledByLease.get(row.leaseId) ?? 0
      return {
        ...row,
        unbilledCents,
        owedCents: Math.max(0, row.balanceCents) + unbilledCents,
        writeOff: writeOffByLease.get(row.leaseId) ?? null,
      }
    })
    .filter((row) => row.owedCents > 0)

  const pursuing = rows.filter((row) => !row.writeOff)
  const writtenOff = rows.filter((row) => row.writeOff)
  return {
    pursuing,
    writtenOff,
    totals: agingTotals(pursuing),
    pursuingCents: pursuing.reduce((sum, row) => sum + row.owedCents, 0),
    writtenOffCents: writtenOff.reduce((sum, row) => sum + row.owedCents, 0),
  }
}
