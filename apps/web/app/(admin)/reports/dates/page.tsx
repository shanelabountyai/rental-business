import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { upcomingCriticalDates } from '@/lib/reports/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Critical dates — Rental Operations' }

// RPT-04's "upcoming critical dates, next 60 days": lease expirations,
// insurance/mortgage renewals, renter's-insurance expiry, deposit-return
// deadlines (R-076), and the compliance calendar (R-077) - the gap R-050
// and R-076 both named honestly rather than overclaiming is closed here,
// `upcomingCriticalDates()` unions `ComplianceItem` in alongside everything
// else rather than this page reading it a second, separate way.
export default async function CriticalDatesPage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const dates = await upcomingCriticalDates(scope, new Date())

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Upcoming critical dates</h1>
        <p className="text-muted-foreground text-sm">Next 60 days.</p>
      </header>

      {dates.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing due in the next 60 days.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {dates.map((date, index) => (
            <li
              key={`${date.propertyId}-${date.kind}-${index}`}
              className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
            >
              <span>
                <span className="font-medium">{date.label}</span>
                <span className="text-muted-foreground"> — {date.propertyName}</span>
              </span>
              <span className="text-muted-foreground text-sm tabular-nums">
                {/* 'UTC', deliberately not the property's own timezone -
                    every source here is a `@db.Date` calendar day, already
                    UTC midnight (CLAUDE.md's own warning on this column
                    type). Reading it through a real zone is the exact
                    off-by-one bug that warning names, not a fix for one. */}
                {friendlyDate(date.dueOn, 'UTC')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
