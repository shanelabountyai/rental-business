import { formatCents } from '@rental/core/money'
import { SCHEDULE_E, UNSOURCED_LINES, isAccountingBasis } from '@rental/core/tax'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { exportableEntities, taxExportFacts } from '@/lib/tax/queries.ts'

export const metadata = { title: 'Tax export — Rental Operations' }

// RPT-03 (R-078): the year-end income/expense export per legal entity,
// mapped to Schedule E lines and QuickBooks accounts.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// The pickers are a real `<form method="get">`, not a client component with
// onChange handlers: this page works on first paint, before hydration, and
// the resulting URL is a bookmark somebody can send to their accountant.

function currentTaxYear(): number {
  return new Date().getUTCFullYear()
}

export default async function TaxExportPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; year?: string; basis?: string }>
}) {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)
  const params = await searchParams

  const entities = exportableEntities(scope)
  const entityId = params.entity ?? entities[0]?.id
  const year = Number(params.year) || currentTaxYear() - 1
  const basis = params.basis && isAccountingBasis(params.basis) ? params.basis : 'cash'

  const report = entityId ? await taxExportFacts(scope, entityId, year, basis) : null
  const years = Array.from({ length: 6 }, (_, index) => currentTaxYear() - index)
  const query = new URLSearchParams({ entity: entityId ?? '', year: String(year), basis })

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Year-end tax export</h1>
        <p className="text-muted-foreground text-sm">
          Income and expenses for one legal entity, sorted onto Schedule E lines and QuickBooks
          accounts. <strong>This is bookkeeping, not tax advice</strong> — every mapping here is a
          default your preparer is free to disagree with.
        </p>
      </header>

      {entities.length === 0 ? (
        <p className="text-muted-foreground text-sm">No legal entities in scope.</p>
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="entity" className="text-sm font-medium">
                Legal entity
              </label>
              <select
                id="entity"
                name="entity"
                defaultValue={entityId}
                className="border-input min-h-11 rounded-md border px-3 py-2 text-sm"
              >
                {entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="year" className="text-sm font-medium">
                Tax year
              </label>
              <select
                id="year"
                name="year"
                defaultValue={String(year)}
                className="border-input min-h-11 rounded-md border px-3 py-2 text-sm"
              >
                {years.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="basis" className="text-sm font-medium">
                Basis
              </label>
              <select
                id="basis"
                name="basis"
                defaultValue={basis}
                className="border-input min-h-11 rounded-md border px-3 py-2 text-sm"
              >
                <option value="cash">Cash — when money moved</option>
                <option value="accrual">Accrual — when it was billed</option>
              </select>
            </div>
            <button
              type="submit"
              className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              Show
            </button>
          </form>

          {report == null ? (
            <p className="text-muted-foreground text-sm">
              No properties in scope for that entity.
            </p>
          ) : (
            <>
              {/* Every section here is NAMED. Four unnamed <section>s in a
                  row give a screen-reader user four identical "region"
                  landmarks, and the totals and the can't-fill list below
                  render the same "Line 18 · …" text for opposite reasons. */}
              <section aria-labelledby="tax-summary" className="flex flex-col gap-3 rounded-md border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="tax-summary" className="text-lg font-semibold">
                    {report.legalEntityName} · {report.year} · {report.basis}
                  </h2>
                  {/* A real link, not a button with a handler: the response
                      IS a file, and `onClick` is inert until hydration. */}
                  <a
                    href={`/api/reports/tax-export?${query.toString()}`}
                    className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
                  >
                    Export CSV
                  </a>
                </div>

                {report.totalsByLine.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Nothing booked to a Schedule E line for this entity and year.
                  </p>
                ) : (
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                    {report.totalsByLine.map((total) => (
                      <div key={total.key} className="contents">
                        <dt className="text-muted-foreground">
                          Line {total.line} · {total.label}
                        </dt>
                        <dd className="text-right tabular-nums">{formatCents(total.amountCents)}</dd>
                      </div>
                    ))}
                    <dt className="border-t pt-1 font-medium">Net (income less expenses)</dt>
                    <dd className="border-t pt-1 text-right font-medium tabular-nums">
                      {formatCents(report.incomeCents - report.expenseCents)}
                    </dd>
                  </dl>
                )}
              </section>

              <section aria-labelledby="tax-held-off" className="flex flex-col gap-2 rounded-md border p-4">
                <h2 id="tax-held-off" className="text-sm font-semibold">
                  Held off Schedule E, deliberately
                </h2>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">
                    Security deposits received (a liability, not income)
                  </dt>
                  <dd className="text-right tabular-nums">
                    {formatCents(report.depositLiabilityCents)}
                  </dd>
                  <dt className="text-muted-foreground">
                    Capital improvements placed in service (depreciable)
                  </dt>
                  <dd className="text-right tabular-nums">{formatCents(report.capexCents)}</dd>
                </dl>
                <p className="text-muted-foreground text-xs">
                  Depreciation is deliberately not computed — method, recovery period and
                  convention are your preparer&rsquo;s call. The CSV carries the schedule they need
                  to make it.
                </p>
              </section>

              <section aria-labelledby="tax-unmapped" className="flex flex-col gap-2 rounded-md border p-4">
                <h2 id="tax-unmapped" className="text-sm font-semibold">
                  Unmapped — {report.exceptions.length}{' '}
                  {report.exceptions.length === 1 ? 'row' : 'rows'},{' '}
                  {formatCents(report.exceptionCents)}
                </h2>
                {report.exceptions.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Every row mapped. Nothing was dropped.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y text-sm">
                    {report.exceptions.map((row) => (
                      <li key={`${row.sourceKind}:${row.sourceId}`} className="flex flex-col gap-1 py-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span>
                            {row.propertyName} · {row.description}
                          </span>
                          <span className="tabular-nums">{formatCents(row.amountCents)}</span>
                        </div>
                        <span className="text-muted-foreground text-xs">{row.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="tax-unsourced" className="flex flex-col gap-2 rounded-md border p-4">
                <h2 id="tax-unsourced" className="text-sm font-semibold">
                  Schedule E lines with nothing on them
                </h2>
                <p className="text-muted-foreground text-xs">
                  Named rather than left blank: a missing expense line reads as a zero, and a zero
                  overstates income. A line that this export DID fill is not listed here.
                </p>
                <ul className="flex flex-col divide-y text-sm">
                  {UNSOURCED_LINES.filter(
                    // R-082: most of these lines became fillable via a vendor
                    // invoice split, so the list is now "empty", not
                    // "impossible" - and a line with money on it must drop off
                    // it entirely rather than tell a reader it cannot exist.
                    (gap) => !report.totalsByLine.some((total) => total.key === gap.key),
                  ).map((gap) => (
                    <li key={gap.key} className="flex flex-col py-2">
                      <span>
                        Line {SCHEDULE_E[gap.key].line} · {SCHEDULE_E[gap.key].label}
                      </span>
                      <span className="text-muted-foreground text-xs">{gap.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
