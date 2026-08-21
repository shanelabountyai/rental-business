import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { cashSummaryByEntity } from '@/lib/reports/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Cash summary — Rental Operations' }

// RPT-04's cash summary: collected vs. billed and the biggest outflows,
// grouped by legal entity rather than the portfolio total the dashboard
// tile already shows (R-076).
export default async function CashSummaryPage() {
  const { actor } = await requireScope('ledger.read')
  const scope = await currentScope(actor)
  const summaries = await cashSummaryByEntity(scope, new Date())

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Cash summary</h1>
        <p className="text-muted-foreground text-sm">
          No reserve target is tracked anywhere in this product yet (R-082) - this shows
          collected vs. billed and the largest outflows only, never a reserve figure nobody
          configured.
        </p>
      </header>

      {summaries.length === 0 ? (
        <p className="text-muted-foreground text-sm">No properties in scope.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {summaries.map((entity) => (
            <li key={entity.legalEntityId} className="flex flex-col gap-3 rounded-md border p-4">
              <h2 className="text-lg font-semibold">{entity.legalEntityName}</h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Collected ({entity.periodLabel})</dt>
                <dd className="tabular-nums">{formatCents(entity.collectedCents)}</dd>
                <dt className="text-muted-foreground">Billed this month</dt>
                <dd className="tabular-nums">{formatCents(entity.billedCents)}</dd>
              </dl>
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">Biggest outflows this month</h3>
                {entity.bigOutflows.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No closed jobs this month.</p>
                ) : (
                  <ul className="text-sm">
                    {entity.bigOutflows.map((outflow) => (
                      <li key={outflow.workOrderId} className="flex justify-between gap-2">
                        <Link
                          href={`/workorders/${outflow.workOrderId}`}
                          className="truncate underline underline-offset-2"
                        >
                          {outflow.description}
                        </Link>
                        <span className="tabular-nums">{formatCents(outflow.costCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
