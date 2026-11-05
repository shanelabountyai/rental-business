import Link from 'next/link'
import { formatCents } from '@rental/core/money'
import { businessDate, friendlyBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { PageHeader } from '@/components/page-header.tsx'
import { ReplayQuickBooksDateForm, SyncQuickBooksNowForm } from '@/components/billing/quickbooks-forms.tsx'
import { INPUT_CLASSES, PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { replayQuickBooksDateAction, syncQuickBooksNowAction } from '@/lib/integrations/quickbooks-actions.ts'
import { reconcileQuickBooks } from '@/lib/integrations/quickbooks-reconcile.ts'
import { orgTimezone } from '@/lib/support/grants.ts'

export const metadata = { title: 'QuickBooks reconciliation' }

// R-283 (PRD 09 Q9, Q10): one entity's month, the platform's totals against
// the company file's per mapped account, and every line that is not in
// QuickBooks yet and why. Owner-only (`billing.connect`), as the connection
// is: the buttons push into somebody's books.

const PROBLEM_WORDS: Record<string, string> = {
  failed: 'Failed',
  pending: 'Not posted',
  not_synced: 'Not synced',
  waiting: 'Waiting',
  excluded: 'Excluded',
  missing_fee: 'No fee',
}

/// Debit positive, credit negative, as the reconciliation computes it.
const drCr = (cents: number) => (cents === 0 ? formatCents(0) : `${formatCents(Math.abs(cents))} ${cents > 0 ? 'Dr' : 'Cr'}`)

export default async function QuickBooksReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; month?: string }>
}) {
  const actor = await requirePermission('billing.connect')
  const [params, zone, connections] = await Promise.all([
    searchParams,
    orgTimezone(actor.orgId),
    prisma.quickBooksConnection.findMany({
      where: { orgId: actor.orgId, status: 'CONNECTED' },
      select: { legalEntityId: true, legalEntity: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const today = businessDate(new Date(), zone)
  const month = params.month ?? today.slice(0, 7)
  const entity = connections.find((c) => c.legalEntityId === params.entity) ?? connections[0]
  const result = entity ? await reconcileQuickBooks(actor.orgId, entity.legalEntityId, month) : null

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title="QuickBooks reconciliation">
        <p className="text-sm text-muted-foreground">
          What this platform says a month&apos;s books hold, against what the QuickBooks company file holds from it, per
          account. Entries a bookkeeper posted by hand are not counted. <Link href="/money/quickbooks" className="underline">Back to QuickBooks</Link>
        </p>
      </PageHeader>

      {!entity ? (
        <p className="text-sm">No entity is connected to QuickBooks yet.</p>
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-3">
            {connections.length > 1 && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="rec-entity" className="text-sm font-medium">
                  Entity
                </label>
                <select id="rec-entity" name="entity" defaultValue={entity.legalEntityId} className={`${INPUT_CLASSES} w-full`}>
                  {connections.map((c) => (
                    <option key={c.legalEntityId} value={c.legalEntityId}>
                      {c.legalEntity.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {connections.length === 1 && <input type="hidden" name="entity" value={entity.legalEntityId} />}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="rec-month" className="text-sm font-medium">
                Month
              </label>
              <input id="rec-month" type="month" name="month" defaultValue={month} required pattern="\d{4}-\d{2}" placeholder="YYYY-MM" className={INPUT_CLASSES} />
            </div>
            <button type="submit" className={`${PRIMARY_BUTTON_CLASSES} min-h-11 px-4`}>
              Show month
            </button>
          </form>

          <h2 className="text-lg font-semibold break-words">{entity.legalEntity.name}</h2>

          {result && !result.ok ? (
            <p role="alert" className="rounded-md border border-danger/35 bg-danger/6 px-3 py-2 text-sm text-danger">
              {result.error}
            </p>
          ) : (
            result && (
              <>
                <section aria-labelledby="rec-accounts" className="flex flex-col gap-3">
                  <h3 id="rec-accounts" className="font-semibold">
                    Totals per account, {friendlyBusinessDate(result.from)} to {friendlyBusinessDate(result.to)}
                  </h3>
                  {result.quickBooksError && (
                    <p className="rounded-md border border-danger/35 bg-danger/6 px-3 py-2 text-sm text-danger">
                      QuickBooks totals could not be read. {result.quickBooksError}
                    </p>
                  )}
                  {result.accounts.length === 0 ? (
                    <p className="text-sm">Nothing posts in this month.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left">
                            <th scope="col" className="py-2 pr-3">Account</th>
                            <th scope="col" className="py-2 pr-3 text-right">Platform</th>
                            <th scope="col" className="py-2 pr-3 text-right">QuickBooks</th>
                            <th scope="col" className="py-2 text-right">Difference</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.accounts.map((row) => {
                            const diff = row.quickBooksCents === null ? null : row.platformCents - row.quickBooksCents
                            return (
                              <tr key={row.key} className="border-b border-border">
                                <th scope="row" className="py-2 pr-3 text-left font-normal break-words">{row.name}</th>
                                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{drCr(row.platformCents)}</td>
                                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                                  {row.quickBooksCents === null ? 'Not read' : drCr(row.quickBooksCents)}
                                </td>
                                <td className={`py-2 text-right tabular-nums whitespace-nowrap ${diff ? 'font-semibold text-danger' : ''}`}>
                                  {diff === null ? '—' : diff === 0 ? 'Matches' : drCr(diff)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section aria-labelledby="rec-problems" className="flex flex-col gap-3">
                  <h3 id="rec-problems" className="font-semibold">
                    Not in QuickBooks ({result.problems.length})
                  </h3>
                  {result.problems.length === 0 ? (
                    <p className="text-sm">Every line of this month is synced.</p>
                  ) : (
                    <ul className="flex flex-col gap-2 break-words text-sm">
                      {result.problems.map((line, index) => (
                        <li key={index} className="rounded-md border border-border px-3 py-2">
                          <span className="font-medium">{PROBLEM_WORDS[line.kind]}</span> · {friendlyBusinessDate(line.day)} ·{' '}
                          {line.property}
                          {line.amountCents !== null && <> · {formatCents(Math.abs(line.amountCents))}</>}
                          <span className="block text-muted-foreground">{line.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )
          )}

          <section aria-labelledby="rec-actions" className="flex flex-col gap-4 rounded-lg border border-border p-4">
            <h3 id="rec-actions" className="font-semibold">
              Push to QuickBooks
            </h3>
            <p className="text-sm text-muted-foreground">
              Both are recorded in the audit log. A day is synced only once it has ended at the property.
            </p>
            <SyncQuickBooksNowForm action={syncQuickBooksNowAction.bind(null, entity.legalEntityId)} />
            <ReplayQuickBooksDateForm action={replayQuickBooksDateAction.bind(null, entity.legalEntityId)} max={today} />
          </section>
        </>
      )}
    </div>
  )
}
