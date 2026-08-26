import {
  ABANDONMENT_STATUS_LABELS,
  ABANDONMENT_OUTCOME_LABELS,
} from '@rental/core/abandonment'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { listAbandonmentCases } from '@/lib/abandonment/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Gone dark — Rental Operations' }

// The tenant-gone-dark register (RISK-01, R-087).
//
// OPEN CASES FIRST, and the reason is not tidiness: a closed case is a
// record, an open one is a tenancy nobody has found the person in. The whole
// risk of this workflow is a case that stalls — either because somebody
// stopped trying, or because nobody entered a unit that needed looking at.

export default async function AbandonmentPage() {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('eviction.manage')
  const scope = await currentScope(actor)
  const cases = await listAbandonmentCases(scope)
  const open = cases.filter((row) => row.status !== 'CLOSED')

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Gone dark</h1>
        <p className="text-muted-foreground text-sm">
          {cases.length} case{cases.length === 1 ? '' : 's'}
          {open.length > 0 && ` · ${open.length} still open`}.
        </p>
      </header>

      <p className="text-muted-foreground text-sm">
        A case is opened on a suspicion, and the commonest outcome is that the
        tenant comes back. Nothing here declares a home abandoned — it records
        what was tried, what was found, and the clocks the statutes run on.
      </p>

      {cases.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No cases. One is opened from a tenancy when somebody stops answering.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {cases.map((row) => (
            <li key={row.id}>
              <Link
                href={`/abandonment/${row.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col gap-1 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {row.propertyName} — {row.unitName}
                  </span>
                  <span
                    className={
                      row.status === 'CLOSED'
                        ? 'rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-900'
                        : 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900'
                    }
                  >
                    {row.outcome
                      ? ABANDONMENT_OUTCOME_LABELS[row.outcome]
                      : ABANDONMENT_STATUS_LABELS[row.status]}
                  </span>
                </span>
                <span className="text-muted-foreground text-sm">
                  {row.tenantNames.join(', ') || 'No tenant recorded'} · opened{' '}
                  {friendlyDate(row.openedAt, row.timezone)} by {row.openedByName} ·{' '}
                  {row.attempts.length} attempt{row.attempts.length === 1 ? '' : 's'} logged
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
