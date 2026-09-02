import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { prospectsForScope } from '@/lib/prospects/queries.ts'

export const metadata = { title: 'Prospects — Rental Operations' }

const STATUS_LABELS: Record<string, string> = {
  INQUIRY: 'Inquiry',
  PRE_SCREENED: 'Pre-screened',
  SHOWING: 'Showing',
  APPLIED: 'Applied',
  SCREENED: 'Screened',
  APPROVED: 'Approved',
  SIGNED: 'Signed',
}

// The prospect pipeline (LEASE-07, R-058): inquiry -> pre-screened ->
// showing -> applied -> screened -> approved -> signed. Only the first two
// stages have anything automated behind them yet - see Prospect's own
// schema comment for which later items own the rest.
export default async function ProspectsPage() {
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)
  const prospects = await prospectsForScope(scope)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Prospects</h1>
        <p className="text-muted-foreground text-sm">
          {prospects.length} prospect{prospects.length === 1 ? '' : 's'}, newest first.
        </p>
      </header>

      {prospects.length === 0 ? (
        <p className="text-muted-foreground text-sm">No inquiries yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {prospects.map((prospect) => (
            <li key={prospect.id}>
              <Link
                href={`/prospects/${prospect.id}`}
                className="hover:bg-secondary focus-visible:ring-ring flex min-h-11 flex-col gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="font-medium">
                  {prospect.firstName} {prospect.lastName}
                </span>
                <span className="text-muted-foreground text-sm">
                  {STATUS_LABELS[prospect.status] ?? prospect.status} · {prospect.source}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
