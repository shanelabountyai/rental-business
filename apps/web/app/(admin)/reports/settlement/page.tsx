import { formatCents } from '@rental/core/money'
import { friendlyBusinessDate } from '@rental/core/scheduling'
import type { BusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { actorDecision, requireScope } from '@/lib/auth/guard.ts'
import {
  type RecordedSettlement,
  recordedSettlements,
  settlementReport,
} from '@/lib/reports/settlement.ts'
import { recordSettlementTransfer } from '@/lib/reports/settlement-actions.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { reportToday } from '@/lib/scope/report-today.ts'
import { SettlementTransferForm } from '@/components/reports/settlement-transfer-form.tsx'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

export const metadata = { title: 'Settlement by entity — Rental Operations' }

// Review finding 12's cheap half (R-180): three LLCs collect into one bank
// account, and nothing told the owner whose money was whose.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// The picker is a real `<form method="get">` so it works before hydration,
// and the URL is a range somebody can send to a bookkeeper.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/// A submitted range, or the current calendar month to date.
///
/// The `<input type="date">` value goes back out RAW - `friendlyBusinessDate`
/// throws on anything that is not `YYYY-MM-DD`, and a date input cannot read
/// "1 Mar 2026" back (D-154). Only the prose above the table is formatted.
function readRange(
  params: { from?: string; to?: string },
  today: BusinessDate,
): { from: BusinessDate; to: BusinessDate } {
  const monthStart = `${today.slice(0, 7)}-01` as BusinessDate
  const from = params.from && DATE_PATTERN.test(params.from) ? (params.from as BusinessDate) : monthStart
  const to = params.to && DATE_PATTERN.test(params.to) ? (params.to as BusinessDate) : today
  // A backwards range is a typo, not an empty month. Swapping it silently
  // beats rendering "no settlements" at somebody who is looking for money.
  return from <= to ? { from, to } : { from: to, to: from }
}

export default async function SettlementReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const { actor } = await requireScope('report.financial')
  const scope = await currentScope(actor)
  const params = await searchParams
  const today = reportToday(scope, new Date())
  const { from, to } = readRange(params, today)
  const report = await settlementReport(scope, from, to)

  // R-198. Recorded transfers are a read, shown to anyone who can see the
  // report; the form is for whoever can move money. An owner who has not
  // enrolled a second factor still sees it - the action's guard sends them to
  // enrol, which beats a form that silently is not there (R-026's lesson).
  const entityIds = report.entities.map((entity) => entity.legalEntityId)
  const [recorded, decisions] = await Promise.all([
    recordedSettlements(entityIds, from, to),
    Promise.all(
      entityIds.map((legalEntityId) => actorDecision('ledger.adjust', { legalEntityId })),
    ),
  ])

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/reports"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Settlement by entity</h1>
        <p className="text-muted-foreground text-sm">
          Online rent for every LLC settles into one Stripe balance and one bank account. This is
          each entity&rsquo;s share of it for a date range, so the funds can be moved deliberately
          and the movement argued from afterwards.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="from" className="text-sm font-medium">
            Settled from
          </label>
          <input
            type="date"
            id="from"
            name="from"
            defaultValue={from}
            className="border-input bg-background focus-visible:ring-ring h-10 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="to" className="text-sm font-medium">
            Settled to
          </label>
          <input
            type="date"
            id="to"
            name="to"
            defaultValue={to}
            className="border-input bg-background focus-visible:ring-ring h-10 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
        </div>
        <button
          type="submit"
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring h-10 rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Show range
        </button>
        <Link
          href={`/api/reports/settlement?from=${from}&to=${to}`}
          className="focus-visible:ring-ring h-10 rounded-md border px-4 text-sm leading-10 font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Download CSV
        </Link>
      </form>

      {/* NAMED, NOT SHOWN AS A ZERO (R-078's rule). Both of these change what
          the number below means, and an owner who reconciles against a bank
          line without knowing them will chase a difference that is not an
          error. */}
      <section aria-labelledby="settlement-caveats" className="rounded-md border p-4">
        <h2 id="settlement-caveats" className="text-sm font-semibold">
          What this total is, and is not
        </h2>
        <ul className="text-muted-foreground mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>
            <strong className="text-foreground">Gross, before Stripe&rsquo;s fees.</strong> Nothing
            in this product records a processing fee — there is no field for one and no event that
            carries one — so a payout is smaller than the figure here by whatever Stripe charged.
          </li>
          <li>
            <strong className="text-foreground">Settlement dates, not payout dates.</strong> Stripe
            pays out on a rolling schedule, so one bank line covers a window shifted a few days
            behind this one. Compare the population, not the calendar boundary.
          </li>
          <li>
            <strong className="text-foreground">Online money only.</strong> A check or cash never
            passed through the Stripe balance and will never appear in a payout;{' '}
            <Link href="/money/deposits" className="underline underline-offset-2">
              deposit slips
            </Link>{' '}
            covers that money separately.
          </li>
        </ul>
      </section>

      <section aria-labelledby="settlement-total" className="rounded-md border p-4">
        <h2 id="settlement-total" className="text-sm font-semibold">
          Into the shared account, {friendlyBusinessDate(from)} to {friendlyBusinessDate(to)}
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          <dt className="text-muted-foreground">Settled</dt>
          <dd className="tabular-nums">{formatCents(report.settledCents)}</dd>
          <dd className="hidden sm:block" />
          <dt className="text-muted-foreground">Returned</dt>
          <dd className="tabular-nums">{formatCents(report.reversedCents)}</dd>
          <dd className="hidden sm:block" />
          <dt className="font-medium">Net across every entity</dt>
          <dd className="font-medium tabular-nums">{formatCents(report.netCents)}</dd>
          <dd className="hidden sm:block" />
        </dl>
      </section>

      {report.entities.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing settled online in this range. Entities with no activity are left out rather than
          shown as zero — a zero row would read as a claim that the LLC collected nothing.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {report.entities.map((entity, index) => (
            <li key={entity.legalEntityId} className="flex flex-col gap-3 rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{entity.entityName}</h2>
                <p className="text-sm">
                  <span className="text-muted-foreground">Owed out of the shared account: </span>
                  <span className="font-medium tabular-nums">{formatCents(entity.netCents)}</span>
                </p>
              </div>
              {entity.reversedCents > 0 && (
                <p className="text-muted-foreground text-sm">
                  {formatCents(entity.settledCents)} settled, less {formatCents(entity.reversedCents)}{' '}
                  returned in this range.
                </p>
              )}
              <div {...scrollableRegionProps(`${entity.entityName} by property`)} className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">{entity.entityName} settlement by property</caption>
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="py-1 pr-3 font-medium">Property</th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">Settled</th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">Returned</th>
                      <th scope="col" className="py-1 text-right font-medium">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entity.properties.map((property) => (
                      <tr key={property.propertyId} className="border-b last:border-0">
                        <th scope="row" className="py-1 pr-3 font-normal">
                          <Link
                            href={`/properties/${property.propertyId}`}
                            className="underline underline-offset-2"
                          >
                            {property.propertyName}
                          </Link>
                        </th>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {formatCents(property.settledCents)}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {formatCents(property.reversedCents)}
                        </td>
                        <td className="py-1 text-right tabular-nums">{formatCents(property.netCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TransferPanel
                entityName={entity.entityName}
                owedCents={entity.netCents}
                recorded={recorded.filter((row) => row.legalEntityId === entity.legalEntityId)}
                canRecord={
                  decisions[index]!.allowed || decisions[index]!.reason === 'mfa_required'
                }
                wholeEntity={scope.availableProperties
                  .filter((property) => property.legalEntityId === entity.legalEntityId)
                  .every((property) => scope.propertyIds.includes(property.id))}
                windowClosed={to < today}
                form={
                  <SettlementTransferForm
                    action={recordSettlementTransfer}
                    entityId={entity.legalEntityId}
                    entityName={entity.entityName}
                    from={from}
                    to={to}
                    owedDollars={(entity.netCents / 100).toFixed(2)}
                    today={today}
                  />
                }
              />
            </li>
          ))}
        </ul>
      )}

      {report.rows.length > 0 && (
        <section aria-labelledby="settlement-payments" className="flex flex-col gap-2">
          <h2 id="settlement-payments" className="text-sm font-semibold">
            Every payment behind those totals
          </h2>
          <p className="text-muted-foreground text-sm">
            What makes the report reconcilable rather than four numbers to trust.
          </p>
          <div {...scrollableRegionProps('Settled payments')} className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <caption className="sr-only">Individual settled payments in this range</caption>
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="p-2 font-medium">Settled</th>
                  <th scope="col" className="p-2 font-medium">Entity</th>
                  <th scope="col" className="p-2 font-medium">Property</th>
                  <th scope="col" className="p-2 font-medium">Payer</th>
                  <th scope="col" className="p-2 text-right font-medium">Amount</th>
                  <th scope="col" className="p-2 font-medium">Returned</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.paymentId} className="border-b last:border-0">
                    <td className="p-2 whitespace-nowrap">{friendlyBusinessDate(row.settledOn)}</td>
                    <td className="p-2">{row.entityName}</td>
                    <td className="p-2">
                      {row.propertyName}
                      {row.unitName ? ` · ${row.unitName}` : ''}
                    </td>
                    <td className="p-2">{row.payerName}</td>
                    <td className="p-2 text-right tabular-nums">{formatCents(row.amountCents)}</td>
                    <td className="p-2 whitespace-nowrap">
                      {row.reversedOn ? friendlyBusinessDate(row.reversedOn) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

/// What happened to one entity's share (R-198).
///
/// A transfer already recorded for any overlapping range REPLACES the form
/// rather than sitting beside it. The action refuses a second one either way,
/// and a form next to the record is an invitation to move the same rent twice.
function TransferPanel({
  entityName,
  owedCents,
  recorded,
  canRecord,
  wholeEntity,
  windowClosed,
  form,
}: {
  entityName: string
  owedCents: number
  recorded: RecordedSettlement[]
  canRecord: boolean
  wholeEntity: boolean
  windowClosed: boolean
  form: ReactNode
}) {
  let body: ReactNode
  if (recorded.length > 0) {
    body = recorded.map((row) => (
      <p key={row.id} className="text-sm">
        Transferred {formatCents(row.transferredCents)} on {friendlyBusinessDate(row.transferredOn)},
        reference {row.reference}, for money settled {friendlyBusinessDate(row.windowFrom)} to{' '}
        {friendlyBusinessDate(row.windowTo)} ({formatCents(row.grossCents)} owed). Recorded by{' '}
        {row.recordedByName}.{' '}
        <a
          href={`/api/documents/${row.documentId}/file`}
          className="focus-visible:ring-ring underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Open the archived report
          <span className="sr-only">
            {' '}
            for {entityName}, {friendlyBusinessDate(row.windowFrom)} to{' '}
            {friendlyBusinessDate(row.windowTo)}
          </span>
        </a>
      </p>
    ))
  } else if (!canRecord) {
    return null
  } else if (owedCents <= 0) {
    body = (
      <p className="text-muted-foreground text-sm">
        Nothing is owed to this entity for this range, so there is no transfer to record.
      </p>
    )
  } else if (!windowClosed) {
    body = (
      <p className="text-muted-foreground text-sm">
        Record the transfer once this range has ended. Money can still settle into it until its
        last day has passed.
      </p>
    )
  } else if (!wholeEntity) {
    body = (
      <p className="text-muted-foreground text-sm">
        Only part of {entityName} is selected. Switch the property selector to the whole entity to
        record its transfer: a share worked out from some of its houses is not what it is owed.
      </p>
    )
  } else {
    body = form
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <h3 className="text-sm font-semibold">
        Transfer out of the shared account<span className="sr-only"> to {entityName}</span>
      </h3>
      {body}
    </div>
  )
}
