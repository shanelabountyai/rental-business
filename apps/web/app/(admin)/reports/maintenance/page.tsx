import { formatCents } from '@rental/core/money'
import {
  addBusinessDays,
  type BusinessDate,
  friendlyDate,
} from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { maintenanceAnalytics } from '@/lib/reports/maintenance.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { reportToday } from '@/lib/scope/report-today.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'Maintenance analytics — Rental Operations' }

// MAINT-10 (R-081c): time-to-resolve by priority, repeat-issue detection,
// reopen rate and cost per vendor.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}

function hours(value: number | null): string {
  if (value == null) return '—'
  if (value < 48) return `${value.toFixed(1)} h`
  return `${(value / 24).toFixed(1)} days`
}

function categoryLabel(category: string): string {
  return category.charAt(0) + category.slice(1).toLowerCase().replace(/_/g, ' ')
}

export default async function MaintenanceAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const params = await searchParams

  // The range ends on the LATEST local day in scope, not on a UTC one - see
  // `reportToday`. `to` is inclusive, so a UTC "today" ran the range into
  // tomorrow from 18:00 onward on every property west of UTC.
  const defaultTo = reportToday(scope, new Date())
  // A year back by default: repeat-issue detection needs enough history to
  // find a chain at all, and a 30-day default would report "no repeats" on a
  // portfolio full of them.
  const defaultFrom = addBusinessDays(defaultTo, -364)
  const isDate = (value: string | undefined): value is BusinessDate =>
    value != null && /^\d{4}-\d{2}-\d{2}$/.test(value)

  const from = isDate(params.from) ? params.from : defaultFrom
  const to = isDate(params.to) ? params.to : defaultTo

  const report = await maintenanceAnalytics(scope, from, to)

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance analytics</h1>
        <p className="text-muted-foreground text-sm">
          How fast things get fixed, what keeps breaking, and what it costs by vendor.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="from" className="text-sm font-medium">
            Tickets from
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from}
            className="border-input min-h-11 rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="to" className="text-sm font-medium">
            to
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to}
            className="border-input min-h-11 rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Show
        </button>
      </form>

      <section aria-labelledby="ma-resolve" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="ma-resolve" className="text-lg font-semibold">
          Time to resolve, by priority
        </h2>
        <p className="text-muted-foreground text-xs">
          The <strong>ticket&rsquo;s</strong> own clock — reported to closed — not a work
          order&rsquo;s. A ticket can outlive several jobs (a callback, a second visit) before it
          closes, and the tenant experienced all of it. Still-open tickets are excluded rather than
          counted as zero.
        </p>
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-sm">
          {Object.entries(report.resolution).map(([priority, stats]) => (
            <div key={priority} className="contents">
              <dt className="text-muted-foreground">{PRIORITY_LABELS[priority] ?? priority}</dt>
              <dd className="text-right tabular-nums">
                {stats.count} closed
              </dd>
              <dd className="text-right tabular-nums">{hours(stats.avgHours)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="ma-repeat" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="ma-repeat" className="text-sm font-semibold">
          Repeat issues — {report.repeats.length}{' '}
          {report.repeats.length === 1 ? 'chain' : 'chains'}
        </h2>
        <p className="text-muted-foreground text-xs">
          The same category on the same home, each report within 90 days of the one before it. The
          chain <strong>extends</strong> rather than resetting at 90 days — four leaks eighty days
          apart are one chronic problem, and cutting the chain would hide exactly the pattern this
          is looking for. Merged tickets are excluded, or two people reporting one leak would
          themselves look like a repeat.
        </p>
        {report.repeats.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing came back twice in this window.
          </p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {report.repeats.map((issue) => (
              <li
                key={`${issue.unitId}:${issue.category}:${issue.firstAt.toISOString()}`}
                className="flex flex-wrap items-baseline justify-between gap-2 py-2"
              >
                <span>
                  {issue.propertyName} · {issue.unitName} · {categoryLabel(issue.category)}
                  <span className="text-muted-foreground block text-xs">
                    {friendlyDate(issue.firstAt, issue.timezone)} to{' '}
                    {friendlyDate(issue.lastAt, issue.timezone)}
                  </span>
                </span>
                <span className="tabular-nums">{issue.count} reports</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ma-cost" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="ma-cost" className="text-sm font-semibold">
          Spend and rework
        </h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Total, jobs closed in this window</dt>
          <dd className="text-right tabular-nums">{formatCents(report.totalCostCents)}</dd>
          <dt className="text-muted-foreground">
            Per unit per month ({report.unitCount} units, {report.months} months)
          </dt>
          <dd className="text-right tabular-nums">
            {formatCents(report.costPerUnitPerMonthCents)}
          </dd>
          <dt className="text-muted-foreground">
            Reopened after being called done ({report.reopen.reopened} of {report.reopen.closed})
          </dt>
          <dd className="text-right tabular-nums">
            {report.reopen.rate == null ? '—' : `${Math.round(report.reopen.rate * 100)}%`}
          </dd>
        </dl>
        <p className="text-muted-foreground text-xs">
          The reopen denominator is jobs that <strong>closed</strong>, not jobs dispatched — an open
          job has not had its chance to come back yet, and counting it would make the rate improve
          just by having a backlog.
        </p>
      </section>

      <section aria-labelledby="ma-vendors" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="ma-vendors" className="text-sm font-semibold">
          Cost by vendor
        </h2>
        <p className="text-muted-foreground text-xs">
          Highest spend first. <strong>The two halves of each row are attributed differently, on
          purpose.</strong> Cost belongs to whoever invoiced the job; the reopen rate is keyed to
          the vendor recorded when the <em>tenant answered</em>, because a reopened job is normally
          reassigned and blaming whoever eventually fixed it would be exactly backwards.
        </p>
        {report.vendors.length === 0 ? (
          <p className="text-muted-foreground text-sm">No vendor jobs closed in this window.</p>
        ) : (
          <div className="overflow-x-auto" {...scrollableRegionProps('Vendor cost table')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Vendor
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Jobs
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Total
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Average
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Reopen rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.vendors.map((vendor) => (
                  <tr key={vendor.vendorId} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">
                      <Link
                        href={`/vendors/${vendor.vendorId}`}
                        className="underline underline-offset-2"
                      >
                        {vendor.vendorName}
                      </Link>
                    </th>
                    <td className="py-2 pr-4 text-right tabular-nums">{vendor.jobs}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatCents(vendor.totalCents)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatCents(vendor.averageCents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {vendor.performance == null ? (
                        <span className="text-muted-foreground text-xs">no answers</span>
                      ) : (
                        `${Math.round(vendor.performance.reopenRate * 100)}%`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
