import { formatCents } from '@rental/core/money'
import { leaseStatusLabel } from '@rental/core/leases'
import Link from 'next/link'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { listLeases } from '@/lib/leases/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Leases — Rental Operations' }

// The tenancy list (LEASE-06, R-033). Running leases first - see
// listLeases's own comment on why the ordering is by meaning rather than by
// date, and why it is done in memory.

function StatusPill({ status, underNotice }: { status: string; underNotice: boolean }) {
  const running = status === 'ACTIVE' || status === 'MONTH_TO_MONTH'
  const over = status === 'ENDED' || status === 'TERMINATED'
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          running
            ? 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100'
            : over
              ? 'bg-muted text-muted-foreground'
              : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
        }`}
      >
        {leaseStatusLabel(status)}
      </span>
      {/*
        Notice is rendered as its own badge ALONGSIDE the status, not
        instead of it - a tenancy under notice is still running, which is
        precisely why there is no NOTICE_GIVEN status to swap in. See
        LeaseStatus's own schema comment.
      */}
      {underNotice && (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Notice given
        </span>
      )}
    </span>
  )
}

export default async function LeasesPage() {
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)
  const [leases, canWrite] = await Promise.all([
    listLeases(scope),
    actorCan('lease.write'),
  ])

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Leases</h1>
          <p className="text-muted-foreground text-sm">
            Tenancies, parties and terms. Running ones first.
          </p>
        </div>
        {canWrite && (
          <Link
            href="/leases/new"
            className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            New lease
          </Link>
        )}
      </header>

      {leases.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No leases in scope yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {leases.map((lease) => {
            const names = lease.leaseTenants
              .map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`)
              .join(', ')
            return (
              <li key={lease.id}>
                <Link
                  href={`/leases/${lease.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col gap-1 rounded-md px-2 py-3 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {lease.property.name} — {lease.unit.name}
                    </span>
                    <StatusPill
                      status={lease.status}
                      underNotice={lease.noticeGivenAt != null}
                    />
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {names || 'Nobody on it yet'}
                    {' · '}
                    {formatCents(lease.rentCents)}/mo
                    {' · '}
                    {lease.startsOn.toISOString().slice(0, 10)}
                    {lease.endsOn ? ` to ${lease.endsOn.toISOString().slice(0, 10)}` : ' (month-to-month)'}
                    {lease.origin === 'INHERITED' && ' · inherited'}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
