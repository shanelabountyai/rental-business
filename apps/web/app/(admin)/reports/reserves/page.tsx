import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { SetReserveForm } from '@/components/reserves/set-reserve-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { setPropertyReserve } from '@/lib/reserves/actions.ts'
import { RESERVE_HORIZON_YEARS, reserveReport } from '@/lib/reserves/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Reserves & capital plan — Rental Operations' }

// PAY-11 (R-082): per-property reserve targets and actuals, and the crude
// capital plan that says whether the target is anywhere near the bill coming.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).

const AGE_SOURCE_LABELS: Record<string, string> = {
  improvement: 'from a recorded replacement',
  appliance: 'from the appliance record',
  assumed_original: 'assumed original — from year built',
  unknown: 'no install date on file',
}

function dollars(cents: number | null | undefined): string {
  return cents == null ? '' : String(Math.round(cents / 100))
}

export default async function ReservesPage() {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)
  const report = await reserveReport(scope, new Date())

  const entityTotals = new Map<string, { name: string; target: number; balance: number | null }>()
  for (const property of report) {
    const running = entityTotals.get(property.legalEntityId) ?? {
      name: property.legalEntityName,
      target: 0,
      balance: null as number | null,
    }
    running.target += property.reserve?.targetCents ?? 0
    // Null stays null until at least one property has a counted balance, and
    // a property with none contributes nothing rather than a zero. Summing
    // unrecorded balances as zero would report an entity as far short of
    // target when the truth is that nobody has counted.
    if (property.reserve?.balanceCents != null) {
      running.balance = (running.balance ?? 0) + property.reserve.balanceCents
    }
    entityTotals.set(property.legalEntityId, running)
  }
  const unrecordedByEntity = new Map<string, number>()
  for (const property of report) {
    if (property.reserve?.balanceCents == null) {
      unrecordedByEntity.set(
        property.legalEntityId,
        (unrecordedByEntity.get(property.legalEntityId) ?? 0) + 1,
      )
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Reserves &amp; capital plan</h1>
        <p className="text-muted-foreground text-sm">
          What each house should be holding against the next roof, furnace and water heater — and
          what it actually holds. <strong>Both figures are typed in.</strong> This product has no
          bank feed: it never sees a distribution taken or a mortgage principal payment, so a
          balance derived from operating income would overstate cash on hand, quietly.
        </p>
      </header>

      {report.length === 0 ? (
        <p className="text-muted-foreground text-sm">No properties in scope.</p>
      ) : (
        <>
          <section aria-labelledby="entity-totals" className="flex flex-col gap-2 rounded-md border p-4">
            <h2 id="entity-totals" className="text-sm font-semibold">
              By legal entity
            </h2>
            <p className="text-muted-foreground text-xs">
              The sum of its properties&rsquo; rows — nothing is stored at the entity level, so
              there is no second figure to disagree with these.
            </p>
            <ul className="flex flex-col divide-y text-sm">
              {[...entityTotals.entries()].map(([entityId, totals]) => (
                <li key={entityId} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{totals.name}</span>
                  <span className="tabular-nums">
                    {formatCents(totals.balance ?? 0)} held / {formatCents(totals.target)} target
                    {unrecordedByEntity.get(entityId) ? (
                      <span className="text-muted-foreground">
                        {' '}
                        · {unrecordedByEntity.get(entityId)}{' '}
                        {unrecordedByEntity.get(entityId) === 1 ? 'property' : 'properties'} with no
                        balance recorded
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {report.map((property) => {
            const status = property.reserve
            return (
              <section
                key={property.propertyId}
                aria-labelledby={`reserve-${property.propertyId}`}
                className="flex flex-col gap-4 rounded-md border p-4"
              >
                <div className="flex flex-col gap-1">
                  <h2 id={`reserve-${property.propertyId}`} className="text-lg font-semibold">
                    <Link
                      href={`/properties/${property.propertyId}`}
                      className="underline underline-offset-2"
                    >
                      {property.propertyName}
                    </Link>
                  </h2>
                  <p className="text-muted-foreground text-xs">{property.legalEntityName}</p>
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <dt className="text-muted-foreground">Target</dt>
                  <dd className="tabular-nums">
                    {status ? formatCents(status.targetCents) : 'Not set'}
                  </dd>
                  <dt className="text-muted-foreground">Held</dt>
                  <dd className="tabular-nums">
                    {status?.balanceCents == null ? (
                      <span className="text-muted-foreground">Not recorded</span>
                    ) : (
                      formatCents(status.balanceCents)
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Gap to target</dt>
                  <dd className="tabular-nums">
                    {status?.shortfallCents == null
                      ? '—'
                      : status.shortfallCents > 0
                        ? `${formatCents(status.shortfallCents)} short`
                        : `${formatCents(-status.shortfallCents)} over`}
                  </dd>
                  <dt className="text-muted-foreground">Should accrue / year</dt>
                  <dd className="tabular-nums">{formatCents(property.annualAccrualCents)}</dd>
                </dl>

                {status?.balanceStale ? (
                  <p className="text-destructive text-sm">
                    That balance was counted on {status.balanceAsOf} — over a year ago. Re-count it
                    before budgeting against it.
                  </p>
                ) : status?.balanceAsOf ? (
                  <p className="text-muted-foreground text-xs">Counted {status.balanceAsOf}.</p>
                ) : null}

                <p className="text-sm">
                  <strong className="tabular-nums">{formatCents(property.dueWithinCents)}</strong> of
                  components come due in the next {RESERVE_HORIZON_YEARS} years, anything already
                  overdue included.
                </p>

                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">
                    The plan behind that number
                  </summary>
                  <div className="overflow-x-auto">
                    <table className="mt-2 w-full text-left text-sm">
                      <caption className="sr-only">
                        Projected component replacements for {property.propertyName}
                      </caption>
                      <thead>
                        <tr className="text-muted-foreground">
                          <th scope="col" className="py-1 pr-3 font-medium">
                            Component
                          </th>
                          <th scope="col" className="py-1 pr-3 font-medium">
                            Age
                          </th>
                          <th scope="col" className="py-1 pr-3 font-medium">
                            Due
                          </th>
                          <th scope="col" className="py-1 font-medium">
                            Estimate
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {property.plan.map((row) => (
                          <tr key={`${row.component}-${row.unitId ?? 'property'}`} className="border-t">
                            <th scope="row" className="py-1.5 pr-3 font-normal">
                              {row.label}
                              {row.unitLabel ? (
                                <span className="text-muted-foreground"> · {row.unitLabel}</span>
                              ) : null}
                              <span className="text-muted-foreground block text-xs">
                                {AGE_SOURCE_LABELS[row.ageSource]}
                              </span>
                            </th>
                            <td className="py-1.5 pr-3 tabular-nums">
                              {row.ageYears == null ? '—' : `${row.ageYears} yr`}
                            </td>
                            <td className="py-1.5 pr-3 tabular-nums">
                              {row.dueYear == null
                                ? 'Unknown'
                                : row.yearsRemaining != null && row.yearsRemaining < 0
                                  ? `${row.dueYear} · overdue`
                                  : row.dueYear}
                            </td>
                            <td className="py-1.5 tabular-nums">
                              {formatCents(row.estimatedCostCents)}
                              {row.costSource === 'default' ? (
                                <span className="text-muted-foreground block text-xs">estimate</span>
                              ) : (
                                <span className="text-muted-foreground block text-xs">
                                  what you last paid
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Crude by design. Ages come from recorded replacements, appliance install dates,
                    or the year built as an explicit assumption — never a guess. Recording the
                    replacement when the work is done is what keeps this current, and replaces the
                    estimate with what you actually paid.
                  </p>
                </details>

                <SetReserveForm
                  action={setPropertyReserve.bind(null, property.propertyId)}
                  idPrefix={`reserve-${property.propertyId}`}
                  targetDollars={dollars(status?.targetCents)}
                  balanceDollars={dollars(status?.balanceCents)}
                  balanceAsOf={status?.balanceAsOf ?? ''}
                />
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
