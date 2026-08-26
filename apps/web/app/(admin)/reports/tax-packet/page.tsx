import { formatCents } from '@rental/core/money'
import { isAccountingBasis } from '@rental/core/tax'
import Link from 'next/link'
import { ArchivePacketPanel } from '@/components/tax/archive-panel.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { archiveTaxPacket } from '@/lib/tax/archive.ts'
import { taxPacket } from '@/lib/tax/packet.ts'
import { exportableEntities } from '@/lib/tax/queries.ts'

export const metadata = { title: 'Tax packet — Rental Operations' }

// RPT-07 (R-081b): the year-end packet — Schedule E per property, the CapEx
// schedule, deposit liability, and the 1099-NEC candidate list.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// R-081d added the archived PDF alongside the screen and the CSV: the CSV is
// the working file a preparer imports, the PDF is the artifact that records
// what they were given on a date.

export default async function TaxPacketPage({
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
  const year = Number(params.year) || thisYear - 1
  const basis = params.basis && isAccountingBasis(params.basis) ? params.basis : 'cash'

  const packet = entityId ? await taxPacket(scope, entityId, year, basis) : null
  const years = Array.from({ length: 6 }, (_, index) => thisYear - index)
  const query = new URLSearchParams({ entity: entityId ?? '', year: String(year), basis })

  const missingW9 = packet?.vendors.filter((vendor) => vendor.missingW9) ?? []

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Year-end tax packet</h1>
        <p className="text-muted-foreground text-sm">
          Everything a preparer asks for in February, for one legal entity.{' '}
          <strong>This is bookkeeping, not tax advice.</strong>
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

          {packet == null ? (
            <p className="text-muted-foreground text-sm">No properties in scope for that entity.</p>
          ) : (
            <>
              <section
                aria-labelledby="pk-schedule-e"
                className="flex flex-col gap-3 rounded-md border p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="pk-schedule-e" className="text-lg font-semibold">
                    {packet.legalEntityName} · {packet.year} · {packet.basis}
                  </h2>
                  {/* A real link, not a button with a handler: the response
                      IS a file, and `onClick` is inert until hydration. */}
                  <a
                    href={`/api/reports/tax-packet?${query.toString()}`}
                    className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
                  >
                    Export CSV
                  </a>
                </div>
                <p className="text-muted-foreground text-xs">
                  Schedule E is filed per property — one column per address — which is why this is
                  broken out here and totalled by entity on the{' '}
                  <Link
                    href={`/reports/tax?${query.toString()}`}
                    className="underline underline-offset-2"
                  >
                    tax export
                  </Link>
                  .
                </p>

                {packet.scheduleE.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No properties to report on.</p>
                ) : (
                  <ul className="flex flex-col gap-4">
                    {packet.scheduleE.map((property) => (
                      <li key={property.propertyId} className="flex flex-col gap-1">
                        <h3 className="text-sm font-medium">
                          <Link
                            href={`/properties/${property.propertyId}`}
                            className="underline underline-offset-2"
                          >
                            {property.propertyName}
                          </Link>
                        </h3>
                        {property.totals.length === 0 ? (
                          <p className="text-muted-foreground text-sm">
                            Nothing booked to a Schedule E line this year.
                          </p>
                        ) : (
                          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                            {property.totals.map((total) => (
                              <div key={total.key} className="contents">
                                <dt className="text-muted-foreground">
                                  Line {total.line} · {total.label}
                                </dt>
                                <dd className="text-right tabular-nums">
                                  {formatCents(total.amountCents)}
                                </dd>
                              </div>
                            ))}
                            <dt className="border-t pt-1 font-medium">Net</dt>
                            <dd className="border-t pt-1 text-right font-medium tabular-nums">
                              {formatCents(property.netCents)}
                            </dd>
                          </dl>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                aria-labelledby="pk-capex"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="pk-capex" className="text-sm font-semibold">
                  Capital improvements placed in service
                </h2>
                <p className="text-muted-foreground text-xs">
                  The fixed-asset schedule a preparer needs to compute line 18. Depreciation is
                  deliberately not computed here — method, recovery period and convention are their
                  call.
                </p>
                {packet.capex.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    None placed in service this year.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y text-sm">
                    {packet.capex.map((row) => (
                      <li key={row.sourceId} className="flex flex-wrap justify-between gap-2 py-2">
                        <span>
                          {row.propertyName} · {row.description}
                          <span className="text-muted-foreground block text-xs">
                            In service {row.bookedOn}
                          </span>
                        </span>
                        <span className="tabular-nums">{formatCents(row.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                aria-labelledby="pk-deposits"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="pk-deposits" className="text-sm font-semibold">
                  Security deposit liability at 31 December {packet.year}
                </h2>
                <p className="text-muted-foreground text-xs">
                  Money still owed back to tenants — a balance, not deposits received this year. A
                  deposit disposed of after 31 December was still held in full on that date.
                </p>
                {packet.depositLiability.byProperty.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No deposits held.</p>
                ) : (
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                    {packet.depositLiability.byProperty.map((row) => (
                      <div key={row.propertyId} className="contents">
                        <dt className="text-muted-foreground">
                          {row.propertyName} ({row.depositCount})
                        </dt>
                        <dd className="text-right tabular-nums">
                          {formatCents(row.liabilityCents)}
                        </dd>
                      </div>
                    ))}
                    <dt className="border-t pt-1 font-medium">Held</dt>
                    <dd className="border-t pt-1 text-right font-medium tabular-nums">
                      {formatCents(packet.depositLiability.totalCents)}
                    </dd>
                  </dl>
                )}
              </section>

              <section
                aria-labelledby="pk-1099"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="pk-1099" className="text-sm font-semibold">
                  1099-NEC candidates
                </h2>
                <p className="text-muted-foreground text-xs">
                  <strong>Card payments are excluded from the reportable figure</strong> — those are
                  reported by the processor on a 1099-K, not by you on a 1099-NEC. Vendors under the
                  threshold are listed too, because &ldquo;just under&rdquo; is a judgement to make
                  with the number in front of you.
                </p>
                {missingW9.length > 0 && (
                  <p className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
                    {missingW9.length} vendor{missingW9.length === 1 ? '' : 's'} over the threshold
                    with no W-9 on file. Chase before January.
                  </p>
                )}
                {packet.vendors.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No vendors paid this year.</p>
                ) : (
                  <ul className="flex flex-col divide-y text-sm">
                    {packet.vendors.map((vendor) => (
                      <li key={vendor.vendorId} className="flex flex-col gap-1 py-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <Link
                            href={`/vendors/${vendor.vendorId}`}
                            className="underline underline-offset-2"
                          >
                            {vendor.vendorName}
                          </Link>
                          <span className="tabular-nums">
                            {formatCents(vendor.reportableCents)}
                          </span>
                        </div>
                        <span className="text-muted-foreground text-xs">
                          {vendor.cardCents > 0 &&
                            `${formatCents(vendor.totalPaidCents)} paid, ${formatCents(vendor.cardCents)} by card (1099-K) · `}
                          {vendor.requiresForm ? '1099-NEC required' : 'Under the threshold'}
                          {vendor.missingW9 && ' · NO W-9 ON FILE'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                aria-labelledby="pk-unmapped"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="pk-unmapped" className="text-sm font-semibold">
                  Unmapped — {packet.exceptions.length}{' '}
                  {packet.exceptions.length === 1 ? 'row' : 'rows'},{' '}
                  {formatCents(packet.exceptionCents)}
                </h2>
                {packet.exceptions.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Every row mapped. Nothing was dropped.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y text-sm">
                    {packet.exceptions.map((row) => (
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

              <section
                aria-labelledby="pk-archive"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="pk-archive" className="text-sm font-semibold">
                  Archive this packet
                </h2>
                <p className="text-muted-foreground text-xs">
                  Produces one PDF of everything above and keeps it. Each one is archived
                  separately rather than regenerated, because a packet is a claim about the books
                  on a date and the books keep moving — so &ldquo;the packet the preparer got in
                  February&rdquo; survives February. Any Form 1098 without an uploaded copy is
                  named on the index rather than quietly left out.
                </p>
                <ArchivePacketPanel
                  action={archiveTaxPacket}
                  entityId={packet.legalEntityId}
                  year={packet.year}
                  basis={packet.basis}
                />
              </section>

              <section
                aria-labelledby="pk-gaps"
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <h2 id="pk-gaps" className="text-sm font-semibold">
                  Not in this packet
                </h2>
                <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                  <li>
                    <strong>Mileage.</strong> Nothing in this product captures trips, so Schedule E
                    line 6 has no source. RPT-07 says &ldquo;if captured&rdquo;; it is not.
                  </li>
                  <li>
                    <strong>Mortgage interest is the lender&rsquo;s figure, not ours.</strong> Line
                    12 comes from the Form 1098 recorded against each loan. This product does not
                    track mortgage payments, so nothing is reconciled against it.
                  </li>
                  <li>
                    <strong>Depreciation.</strong> The CapEx schedule above is the input; the
                    calculation is your preparer&rsquo;s.
                  </li>
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
