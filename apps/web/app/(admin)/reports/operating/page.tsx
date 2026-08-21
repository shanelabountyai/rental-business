import { formatCents } from '@rental/core/money'
import { UNATTRIBUTED_TRADE, vacancyRate } from '@rental/core/metrics'
import { isAccountingBasis } from '@rental/core/tax'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { operatingReport } from '@/lib/reports/operating.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { exportableEntities } from '@/lib/tax/queries.ts'

export const metadata = { title: 'Operating report — Rental Operations' }

// RPT-05 (R-081a): the per-property operating snapshot - "which house is a
// lemon" - plus the monthly P&L, vendor spend by trade, renewal rate and
// turn cost behind it.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// Pickers are a real `<form method="get">`: works on first paint, and the URL
// is a bookmark somebody can send to a partner.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function tradeLabel(trade: string): string {
  if (trade === UNATTRIBUTED_TRADE) return 'Not attributed'
  return trade.charAt(0) + trade.slice(1).toLowerCase().replace(/_/g, ' ')
}

export default async function OperatingReportPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; year?: string; basis?: string }>
}) {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)
  const params = await searchParams

  const entities = exportableEntities(scope)
  const entityId = params.entity ?? entities[0]?.id
  const thisYear = new Date().getUTCFullYear()
  const year = Number(params.year) || thisYear
  // ACCRUAL BY DEFAULT, and this one is not a coin toss. On a cash basis
  // R-078 sends owner-absorbed utility bills to the exception list, because
  // nothing records when a utility bill was paid - so a cash-basis operating
  // P&L understates expenses by exactly that amount, silently. An operating
  // report also wants a cost booked to the period it belongs to rather than
  // the month a cheque cleared. The picker stays because D-71 settled that
  // the basis is the reader's call, not ours.
  const basis = params.basis && isAccountingBasis(params.basis) ? params.basis : 'accrual'

  const report = entityId ? await operatingReport(scope, entityId, year, basis) : null
  const years = Array.from({ length: 6 }, (_, index) => thisYear - index)

  const entityIncome = report?.snapshot.reduce((t, row) => t + row.incomeCents, 0) ?? 0
  const entityExpense = report?.snapshot.reduce((t, row) => t + row.expenseCents, 0) ?? 0
  const entityTurn = report?.snapshot.reduce((t, row) => t + row.turnCostCents, 0) ?? 0

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Operating report</h1>
        <p className="text-muted-foreground text-sm">
          What each house earned, cost, and sat empty for. An operating view — full financial
          statements are QuickBooks&rsquo; job (RPT-09), so nothing here balances to a trial balance.
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
                Year
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
                <option value="accrual">Accrual — when it was billed</option>
                <option value="cash">Cash — when money moved</option>
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
            <p className="text-muted-foreground text-sm">No properties in scope for that entity.</p>
          ) : report.snapshot.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No properties on {report.legalEntityName} to report on.
            </p>
          ) : (
            <>
              <section
                aria-labelledby="op-lemon"
                className="flex flex-col gap-3 rounded-md border p-4"
              >
                <h2 id="op-lemon" className="text-lg font-semibold">
                  {report.legalEntityName} · {report.year} · {report.basis}
                </h2>
                <p className="text-muted-foreground text-xs">
                  Worst net first — a list sorted by name buries the house that is losing money.
                </p>

                {/* THE FIRST REAL <table> IN THIS APP, and a deliberate break
                    from the divided-<ul> house style rather than an oversight.
                    Every other list here is a list of links; this is a grid
                    where a cell means nothing without BOTH its row and its
                    column ("Cedar Row, vacant days"). `<th scope>` is how a
                    screen reader announces that pairing, and no arrangement of
                    <ul> can express it. */}
                {/* FOCUSABLE, because it scrolls. A keyboard user cannot
                    reach a horizontal scrollbar that no element owns, and the
                    defect is invisible at a desktop width where the table
                    happens to fit. */}
                <div
                  className="overflow-x-auto"
                  tabIndex={0}
                  role="group"
                  aria-label="Per-property operating snapshot, scrolls sideways"
                >
                  <table className="w-full min-w-3xl border-collapse text-sm">
                    <caption className="sr-only">
                      Per-property operating snapshot for {report.year}
                    </caption>
                    <thead>
                      <tr className="border-b text-left">
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Property
                        </th>
                        <th scope="col" className="py-2 pr-4 text-right font-medium">
                          Income
                        </th>
                        <th scope="col" className="py-2 pr-4 text-right font-medium">
                          Maintenance
                        </th>
                        <th scope="col" className="py-2 pr-4 text-right font-medium">
                          All expenses
                        </th>
                        <th scope="col" className="py-2 pr-4 text-right font-medium">
                          Net
                        </th>
                        <th scope="col" className="py-2 pr-4 text-right font-medium">
                          Vacant days
                        </th>
                        <th scope="col" className="py-2 text-right font-medium">
                          Tickets
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.snapshot.map((row) => {
                        const rate = vacancyRate(row)
                        return (
                          <tr key={row.propertyId} className="border-b last:border-0">
                            <th scope="row" className="py-2 pr-4 text-left font-normal">
                              <Link
                                href={`/properties/${row.propertyId}`}
                                className="underline underline-offset-2"
                              >
                                {row.propertyName}
                              </Link>
                              <span className="text-muted-foreground block text-xs">
                                {row.unitCount} {row.unitCount === 1 ? 'unit' : 'units'}
                              </span>
                            </th>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {formatCents(row.incomeCents)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {formatCents(row.maintenanceSpendCents)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {formatCents(row.expenseCents)}
                            </td>
                            <td
                              className={`py-2 pr-4 text-right font-medium tabular-nums ${
                                row.netCents < 0 ? 'text-red-700 dark:text-red-400' : ''
                              }`}
                            >
                              {formatCents(row.netCents)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {row.vacantDays}
                              {rate != null && (
                                <span className="text-muted-foreground block text-xs">
                                  {Math.round(rate * 100)}%
                                </span>
                              )}
                            </td>
                            <td className="py-2 text-right tabular-nums">{row.ticketCount}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section
                aria-labelledby="op-monthly"
                className="flex flex-col gap-3 rounded-md border p-4"
              >
                <h2 id="op-monthly" className="text-sm font-semibold">
                  Monthly net, per property
                </h2>
                <p className="text-muted-foreground text-xs">
                  Income less operating expenses. Capital improvements are excluded — a roof is
                  depreciated, not charged against the month it was fitted — and so are security
                  deposits, which are money held rather than earned.
                </p>
                <div
                  className="overflow-x-auto"
                  tabIndex={0}
                  role="group"
                  aria-label="Monthly net per property, scrolls sideways"
                >
                  <table className="w-full min-w-3xl border-collapse text-sm">
                    <caption className="sr-only">
                      Monthly net per property for {report.year}
                    </caption>
                    <thead>
                      <tr className="border-b text-left">
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Property
                        </th>
                        {MONTH_LABELS.map((month) => (
                          <th key={month} scope="col" className="py-2 pr-3 text-right font-medium">
                            {month}
                          </th>
                        ))}
                        <th scope="col" className="py-2 text-right font-medium">
                          Year
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.pandl.map((property) => (
                        <tr key={property.propertyId} className="border-b last:border-0">
                          <th scope="row" className="py-2 pr-4 text-left font-normal">
                            {property.propertyName}
                          </th>
                          {property.months.map((cell) => (
                            <td
                              key={cell.month}
                              className={`py-2 pr-3 text-right tabular-nums ${
                                cell.netCents < 0 ? 'text-red-700 dark:text-red-400' : ''
                              }`}
                            >
                              {cell.netCents === 0 ? '—' : formatCents(cell.netCents)}
                            </td>
                          ))}
                          <td className="py-2 text-right font-medium tabular-nums">
                            {formatCents(property.netCents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section
                aria-labelledby="op-entity"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="op-entity" className="text-sm font-semibold">
                  {report.legalEntityName} — the year
                </h2>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Income</dt>
                  <dd className="text-right tabular-nums">{formatCents(entityIncome)}</dd>
                  <dt className="text-muted-foreground">Operating expenses</dt>
                  <dd className="text-right tabular-nums">{formatCents(entityExpense)}</dd>
                  <dt className="border-t pt-1 font-medium">Net</dt>
                  <dd className="border-t pt-1 text-right font-medium tabular-nums">
                    {formatCents(entityIncome - entityExpense)}
                  </dd>
                  <dt className="text-muted-foreground">Turn cost</dt>
                  <dd className="text-right tabular-nums">{formatCents(entityTurn)}</dd>
                  <dt className="text-muted-foreground">
                    Renewal rate ({report.renewal.renewed} renewed ·{' '}
                    {report.renewal.endedWithoutRenewal} not)
                  </dt>
                  <dd className="text-right tabular-nums">
                    {report.renewal.renewed + report.renewal.endedWithoutRenewal === 0
                      ? '—'
                      : `${Math.round(report.renewal.rate * 100)}%`}
                  </dd>
                </dl>
                {report.unmappedCount > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {report.unmappedCount} row{report.unmappedCount === 1 ? '' : 's'} totalling{' '}
                    {formatCents(report.unmappedCents)} could not be classified and are excluded
                    from these totals.{' '}
                    <Link
                      href={`/reports/tax?entity=${report.legalEntityId}&year=${report.year}&basis=${report.basis}`}
                      className="underline underline-offset-2"
                    >
                      See them on the tax export
                    </Link>
                    .
                  </p>
                )}
              </section>

              <section
                aria-labelledby="op-trades"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="op-trades" className="text-sm font-semibold">
                  Maintenance spend by trade
                </h2>
                <p className="text-muted-foreground text-xs">
                  Attributed by what the work WAS — the ticket&rsquo;s category, or the preventive
                  template behind a batch job — never by the vendor&rsquo;s registered trades, which
                  are a list of what they can do and would double-count a two-trade vendor.
                </p>
                {report.tradeSpend.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No maintenance spend this year.</p>
                ) : (
                  <ul className="flex flex-col divide-y text-sm">
                    {report.tradeSpend.map((row) => (
                      <li key={row.trade} className="flex justify-between gap-4 py-2">
                        <span>
                          {tradeLabel(row.trade)}
                          <span className="text-muted-foreground text-xs">
                            {' '}
                            · {row.jobCount} {row.jobCount === 1 ? 'job' : 'jobs'}
                          </span>
                        </span>
                        <span className="tabular-nums">{formatCents(row.costCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
