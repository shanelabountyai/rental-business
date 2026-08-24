import { EVICTION_STAGE_LABELS, type EvictionStageValue } from '@rental/core/evictions'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { listEvictionCases } from '@/lib/evictions/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Evictions — Rental Operations' }

// The delinquency-to-eviction path as a case file (PAY-14, R-083).
//
// THIS SYSTEM NEVER FILES ANYTHING ANYWHERE - it records what a human did so
// the file can be handed to an attorney. Open cases sort first because they
// are the ones with clocks running.
export default async function EvictionsPage() {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('eviction.manage')
  const scope = await currentScope(actor)
  const cases = await listEvictionCases(scope)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Evictions</h1>
        <Link
          href="/evictions/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Open a case
        </Link>
      </div>
      <p className="text-muted-foreground text-sm">
        Nothing here is filed with any court by this system. These are records of what has already been done.
      </p>

      {cases.length === 0 ? (
        <p className="text-muted-foreground text-sm">No eviction cases on file.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {cases.map((row) => (
            <li key={row.id}>
              <Link
                href={`/evictions/${row.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {row.property.name} — {row.unit.name}
                  {row.closedAt && <span className="text-muted-foreground"> (closed)</span>}
                </span>
                <span className="text-muted-foreground text-sm">
                  {row.lease.leaseTenants
                    .map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`)
                    .join(', ') || 'No tenant recorded'}{' '}
                  · {EVICTION_STAGE_LABELS[row.stage as EvictionStageValue]} · opened{' '}
                  {friendlyDate(row.openedAt, row.property.timezone)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
