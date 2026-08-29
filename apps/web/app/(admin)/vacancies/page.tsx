import { formatCents } from '@rental/core/money'
import { friendlyBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { thisWeekLeasingActivity, vacantUnitsWithTurnover } from '@/lib/reports/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Vacancies — Rental Operations' }

const STAGE_LABELS: Record<string, string> = {
  TRASH_OUT: 'Trash-out',
  REPAIRS: 'Repairs',
  PAINT: 'Paint',
  FLOORS: 'Floors',
  CLEAN: 'Clean',
  REKEY: 'Re-key',
  OTHER: 'Other',
}

// The dashboard's vacancies tile drilling into a real list (R-050, RPT-01),
// extended into RPT-04's "vacancy and turn status" weekly report (R-076):
// each vacancy's own turnover stage and target rent-ready date, plus this
// week's leasing activity feeding the pipeline behind them.
export default async function VacanciesPage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const now = new Date()
  const [units, activity] = await Promise.all([
    vacantUnitsWithTurnover(scope, now),
    thisWeekLeasingActivity(scope, now),
  ])
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

      <section aria-labelledby="this-week" className="flex flex-col gap-2">
        <h2 id="this-week" className="text-sm font-semibold">
          This week&rsquo;s leasing activity
        </h2>
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div className="flex flex-col gap-1 rounded-lg border p-3">
            <dt className="text-muted-foreground text-xs font-medium">New leads</dt>
            <dd className="text-xl font-semibold tabular-nums">{activity.newLeads}</dd>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border p-3">
            <dt className="text-muted-foreground text-xs font-medium">Showings</dt>
            <dd className="text-xl font-semibold tabular-nums">{activity.showingsScheduled}</dd>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border p-3">
            <dt className="text-muted-foreground text-xs font-medium">Applications</dt>
            <dd className="text-xl font-semibold tabular-nums">{activity.applicationsStarted}</dd>
          </div>
        </dl>
      </section>

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
                  {unit.currentStage && (
                    <> · {STAGE_LABELS[unit.currentStage] ?? unit.currentStage}</>
                  )}
                  {unit.targetRentReadyDate && <> · rent-ready {friendlyBusinessDate(unit.targetRentReadyDate)}</>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
