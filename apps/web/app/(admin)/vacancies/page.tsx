import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { vacantUnits } from '@/lib/dashboard/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Vacancies — Rental Operations' }

// The dashboard's vacancies tile drilling into a real list (R-050, RPT-01).
// No cross-property unit list existed before this - units were only ever
// browsed per-property under /properties/[id]. `vacantUnits()` is the same
// query the tile's own numbers are folded from, so the two can't disagree.
export default async function VacanciesPage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const units = await vacantUnits(scope, new Date())
  const sorted = [...units].sort((a, b) => b.daysOnMarket - a.daysOnMarket)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/dashboard"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Vacancies</h1>
        <p className="text-muted-foreground text-sm">
          {sorted.length} unit{sorted.length === 1 ? '' : 's'} vacant or in make-ready,
          oldest first.
        </p>
      </header>

      {sorted.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing vacant right now.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {sorted.map((unit) => (
            <li key={unit.id}>
              <Link
                href={`/properties/${unit.propertyId}/units/${unit.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-11 flex-col gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="font-medium">
                  {unit.propertyName} — {unit.name}
                </span>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {unit.daysOnMarket} day{unit.daysOnMarket === 1 ? '' : 's'} on market
                  {unit.dailyCostCents != null && (
                    <> · {formatCents(unit.dailyCostCents)}/day</>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
