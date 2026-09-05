import { depositChannelLabel } from '@rental/core/payments'
import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { DepositBatchList } from '@/components/payments/deposit-batch-list.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { createDepositBatch } from '@/lib/payments/deposit-actions.ts'
import { listUndepositedDepositGroups } from '@/lib/payments/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Deposits — Rental Operations' }

// PAY-05's other named leftover, R-166: undeposited checks, money orders and
// cash, grouped into the trip to the bank they would make.
//
// NO loading.tsx ABOVE OR HERE - this page reads nothing that calls
// notFound(), but the rule is repo-wide (CLAUDE.md) and the reflex costs
// nothing to keep.

export default async function DepositsPage() {
  // Guards itself rather than relying on the layout, same posture /money's
  // own page takes - the layout proves the visitor is staff; this proves
  // they may see THIS section.
  const { actor } = await requireScope('ledger.adjust')
  const scope = await currentScope(actor)
  const groups = await listUndepositedDepositGroups(scope)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/money"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Money
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Deposits</h1>
        <p className="text-muted-foreground text-sm">
          Checks, money orders and cash not yet taken to the bank, grouped by
          the trip each one would make - one legal entity, one day, one
          person.
        </p>
      </header>

      <DepositBatchList
        groups={groups.map((group) => ({
          key: `${group.legalEntityId}|${group.receivedOn}|${group.receivedByStaffId}`,
          receivedOn: group.receivedOn,
          receivedByName: group.receivedByName,
          entityName: group.entityName,
          totalAmount: formatCents(group.totalCents),
          payments: group.payments.map((payment) => ({
            id: payment.id,
            description: payment.description,
            channelLabel: depositChannelLabel(payment.channel),
            checkNumber: payment.checkNumber,
            amount: formatCents(payment.amountCents),
          })),
        }))}
        action={createDepositBatch}
      />
    </div>
  )
}
