import Link from 'next/link'
import { AGING_BUCKETS, BUCKET_LABELS } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { friendlyBusinessDate } from '@rental/core/scheduling'
import { propertyScope, scopeIsEmpty } from '@rental/core/rbac'
import { WriteOffForm } from '@/components/money/write-off-form.tsx'
import { scrollableRegionProps } from '@/components/ui-classes.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import { type FormerTenantRow, formerTenantReceivables } from '@/lib/payments/former-tenants.ts'
import { writeOffReceivable } from '@/lib/payments/write-off-actions.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Former tenants — Rental Operations' }

// Money owed by tenants who have moved out (R-215). The rent roll's
// arithmetic over ended tenancies - see lib/payments/former-tenants.ts.
//
// NO `loading.tsx` HERE OR ABOVE (R-099), for the rent roll's reason.

export default async function FormerTenantsPage() {
  const { actor } = await requireScope('ledger.read')
  const scope = await currentScope(actor)
  const canWriteOff = !scopeIsEmpty(propertyScope(actor, 'ledger.adjust'))
  const receivables = await formerTenantReceivables(scope)

  return (
    <div className="flex flex-col gap-6 break-words">
      <header className="flex flex-col gap-1">
        <Link
          href="/money"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Money
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Former tenants</h1>
        <p className="text-muted-foreground text-sm">
          What tenants who have moved out still owe: unpaid rent and fees, and
          damage beyond their deposit. Worst first.
        </p>
      </header>

      <section aria-labelledby="former-aging" className="flex flex-col gap-3">
        <h2 id="former-aging" className="text-lg font-semibold">
          Still being pursued
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {AGING_BUCKETS.map((bucket) => (
            <div key={bucket} className="flex flex-col gap-1 rounded-lg border p-3">
              <dt className="text-muted-foreground text-xs font-medium">{BUCKET_LABELS[bucket]}</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {formatCents(Math.max(0, receivables.totals[bucket].balanceCents))}
              </dd>
              <dd className="text-muted-foreground text-xs">
                {receivables.totals[bucket].count}{' '}
                {receivables.totals[bucket].count === 1 ? 'tenancy' : 'tenancies'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-sm">
          {formatCents(receivables.pursuingCents)} owed by former tenants
          {receivables.writtenOffCents > 0 &&
            `, plus ${formatCents(receivables.writtenOffCents)} written off and no longer pursued`}
          .
        </p>
        {receivables.pursuing.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No former tenant owes anything at the properties you can see.
          </p>
        ) : (
          <ReceivablesTable
            caption="Former tenants still owing"
            rows={receivables.pursuing}
            canWriteOff={canWriteOff}
          />
        )}
      </section>

      {receivables.writtenOff.length > 0 && (
        <section aria-labelledby="written-off" className="flex flex-col gap-3">
          <h2 id="written-off" className="text-lg font-semibold">
            Written off
          </h2>
          <p className="text-muted-foreground text-sm">
            Still owed, and still on the ledger. Nobody is chasing these.
          </p>
          <ReceivablesTable caption="Written-off balances" rows={receivables.writtenOff} canWriteOff={false} />
        </section>
      )}
    </div>
  )
}

function ReceivablesTable({
  caption,
  rows,
  canWriteOff,
}: {
  caption: string
  rows: FormerTenantRow[]
  canWriteOff: boolean
}) {
  return (
    <div className="overflow-x-auto" {...scrollableRegionProps(`${caption}, scrolls sideways`)}>
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 pr-3 font-medium">Tenancy</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Owed</th>
            <th scope="col" className="py-2 pr-3 font-medium">How old</th>
            <th scope="col" className="py-2 font-medium">Last contacted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.leaseId} className="border-b align-top">
              <td className="py-2 pr-3">
                <Link href={`/leases/${row.leaseId}`} className="underline underline-offset-2">
                  {row.tenantName}
                </Link>
                <span className="text-muted-foreground block text-xs">
                  {row.propertyName} · {row.unitName}
                </span>
                {row.writeOff ? (
                  <span className="text-muted-foreground block text-xs">
                    {formatCents(row.writeOff.amountCents)} written off{' '}
                    {friendlyBusinessDate(row.writeOff.writtenOffOn)}: {row.writeOff.reason}
                  </span>
                ) : (
                  canWriteOff && (
                    <WriteOffForm
                      action={writeOffReceivable.bind(null, row.leaseId)}
                      tenantName={row.tenantName}
                      idPrefix={`write-off-${row.leaseId}`}
                    />
                  )
                )}
              </td>
              <td className="py-2 pr-3 text-right font-medium tabular-nums">
                {formatCents(row.owedCents)}
                {row.unbilledCents > 0 && (
                  <span className="block text-xs font-normal text-amber-800">
                    {formatCents(row.unbilledCents)} not yet billed
                  </span>
                )}
              </td>
              <td className="py-2 pr-3">
                {row.bucket === 'current' ? 'Not yet due' : BUCKET_LABELS[row.bucket]}
                {row.oldestDueOn && (
                  <span className="text-muted-foreground block text-xs">
                    oldest due {friendlyBusinessDate(row.oldestDueOn)}
                  </span>
                )}
              </td>
              <td className="text-muted-foreground py-2">
                {row.lastContactOn ? friendlyBusinessDate(row.lastContactOn) : 'never'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
