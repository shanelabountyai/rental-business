import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { leasingFunnel } from '@/lib/reports/funnel.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { friendlyBusinessDate, type BusinessDate } from '@rental/core/scheduling'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'Leasing funnel — Rental Operations' }

// RPT-06 (R-081c): leads by source, showing→application→approval conversion,
// days-to-fill per vacancy, and channel quality.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// The date pickers are a real `<form method="get">` — they work on first
// paint, and the URL is a bookmark somebody can send to a colleague.

function percent(value: number | null): string {
  return value == null ? '—' : `${Math.round(value * 100)}%`
}

function sourceLabel(source: string): string {
  if (source === 'direct') return 'Direct'
  return source.charAt(0) + source.slice(1).toLowerCase().replace(/_/g, ' ')
}

export default async function LeasingFunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const params = await searchParams

  const today = new Date()
  const defaultTo = today.toISOString().slice(0, 10) as BusinessDate
  const ninetyBack = new Date(today.getTime() - 89 * 86_400_000)
  const defaultFrom = ninetyBack.toISOString().slice(0, 10) as BusinessDate
  const isDate = (value: string | undefined): value is BusinessDate =>
    value != null && /^\d{4}-\d{2}-\d{2}$/.test(value)

  const from = isDate(params.from) ? params.from : defaultFrom
  const to = isDate(params.to) ? params.to : defaultTo

  const report = await leasingFunnel(scope, from, to)
  const stillVacant = report.fills.filter((fill) => !fill.isFinal).length

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Leasing funnel</h1>
        <p className="text-muted-foreground text-sm">
          Where prospects stop, which channels send people who qualify, and how long a home sits
          empty.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="from" className="text-sm font-medium">
            Inquiries from
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

      <section aria-labelledby="lf-funnel" className="flex flex-col gap-3 rounded-md border p-4">
        <h2 id="lf-funnel" className="text-lg font-semibold">
          The funnel
        </h2>
        <p className="text-muted-foreground text-xs">
          One row per <strong>person</strong>, not per booking — somebody who rescheduled twice is
          one prospect who viewed the home. Conversion is measured{' '}
          <strong>within the group that reached the previous stage</strong>, so it can never exceed
          100%; people who reached a stage without the one before it are counted separately as
          &ldquo;skipped&rdquo;, because applying without booking a viewing first is ordinary
          rather than an error.
        </p>
        <ul className="flex flex-col divide-y text-sm">
          {report.steps.map((step, index) => (
            <li key={step.stage} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <span className="font-medium">{step.label}</span>
              <span className="flex items-baseline gap-4">
                {step.skipped > 0 && (
                  <span className="text-muted-foreground text-xs">
                    {step.skipped} skipped the previous stage
                  </span>
                )}
                {/* A null conversion has TWO different causes and they must not
                    read the same. The first row genuinely has no previous
                    stage; a later row is null only because nobody reached the
                    stage before it — and labelling that one "first stage"
                    tells the reader that Approved is where the funnel starts,
                    which is false. */}
                <span className="text-muted-foreground text-xs">
                  {index === 0
                    ? 'first stage'
                    : step.conversion == null
                      ? 'nobody reached the previous stage'
                      : `${percent(step.conversion)} of previous`}
                </span>
                <span className="tabular-nums">{step.count}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="lf-sources" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="lf-sources" className="text-sm font-semibold">
          Channel quality
        </h2>
        <p className="text-muted-foreground text-xs">
          Named inquiries and what became of them, best approval rate first. A channel sending a
          hundred people who never qualify is worse than one sending five who do.
        </p>
        {report.sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">No inquiries in this window.</p>
        ) : (
          <div className="overflow-x-auto" {...scrollableRegionProps('Channel quality table')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Channel
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Inquiries
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Viewed
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Applied
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Approved
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Approval rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.sources.map((row) => (
                  <tr key={row.source} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">
                      {sourceLabel(row.source)}
                    </th>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.inquiries}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.showings}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.applications}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.approvals}</td>
                    <td className="py-2 text-right tabular-nums">{percent(row.approvalRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="lf-leads" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="lf-leads" className="text-sm font-semibold">
          Listing visits by source
        </h2>
        <p className="text-muted-foreground text-xs">
          Anonymous visits carrying a network tag. <strong>Deliberately not divided into the
          funnel above</strong> — a visit has no person attached and nothing keys it to an inquiry,
          so a visit-to-inquiry rate would be two unrelated populations divided by each other.
        </p>
        {report.leads.length === 0 ? (
          <p className="text-muted-foreground text-sm">No listing visits in this window.</p>
        ) : (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            {report.leads.map((lead) => (
              <div key={lead.source} className="contents">
                <dt className="text-muted-foreground">{sourceLabel(lead.source)}</dt>
                <dd className="text-right tabular-nums">{lead.visits}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="lf-fill" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="lf-fill" className="text-sm font-semibold">
          Days to fill —{' '}
          {report.medianDaysToFill == null
            ? 'nothing filled in this window'
            : `${report.medianDaysToFill} days, typical`}
        </h2>
        <p className="text-muted-foreground text-xs">
          One row per vacancy that <em>started</em> in this window, longest first. The headline is
          the <strong>median of the vacancies that actually ended</strong> — a mean would follow
          one house that sat empty through a roof replacement, and a unit still empty today has a
          number that has not finished happening.
          {stillVacant > 0 && ` ${stillVacant} still vacant, counting.`}
        </p>
        {report.fills.length === 0 ? (
          <p className="text-muted-foreground text-sm">No vacancies started in this window.</p>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {report.fills.map((fill) => (
              <li
                key={`${fill.unitId}:${fill.vacatedOn}`}
                className="flex flex-wrap items-baseline justify-between gap-2 py-2"
              >
                <span>
                  {fill.propertyName} · {fill.unitName}
                  <span className="text-muted-foreground block text-xs">
                    Vacated {friendlyBusinessDate(fill.vacatedOn)}
                    {fill.filledOn ? ` · filled ${friendlyBusinessDate(fill.filledOn)}` : ' · still vacant'}
                  </span>
                </span>
                <span className="tabular-nums">
                  {fill.days} {fill.days === 1 ? 'day' : 'days'}
                  {!fill.isFinal && <span className="text-muted-foreground text-xs"> so far</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lf-gaps" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="lf-gaps" className="text-sm font-semibold">
          Not in this report
        </h2>
        <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
          <li>
            <strong>Cost per channel.</strong> RPT-06 asks for cost as well as quality, and nothing
            in this product records what a listing on a network costs — there is no ad-spend record
            anywhere. A cost column would be a zero standing in for &ldquo;unknown&rdquo;, so there
            is no cost column.
          </li>
          <li>
            <strong>Signed leases are not a funnel stage.</strong> Approval is where screening ends;
            an approved household that never signed is a different problem from one that never
            applied, and it is the renewal and turn reports that follow the tenancy.
          </li>
        </ul>
      </section>
    </div>
  )
}
