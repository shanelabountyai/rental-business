import { formatCents } from '@rental/core/money'
import { daysUntilExpiry, expiryWindow, leaseStatusLabel } from '@rental/core/leases'
import { businessDate, friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
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
            ? 'bg-green-100 text-green-900'
            : over
              ? 'bg-muted text-muted-foreground'
              : 'bg-amber-100 text-amber-900'
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
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
          Notice given
        </span>
      )}
    </span>
  )
}

export default async function LeasesPage({
  searchParams,
}: {
  searchParams: Promise<{ expiresWithin?: string }>
}) {
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)
  const [{ expiresWithin }, allLeases, canWrite] = await Promise.all([
    searchParams,
    listLeases(scope),
    actorCan('lease.write'),
  ])

  // R-050's dashboard drills in with `?expiresWithin=90|120` - the same
  // `daysUntilExpiry`/`expiryWindow` the tile itself buckets by (a
  // month-to-month lease has no term and is never included).
  const now = new Date()
  const window = expiresWithin === '90' ? 90 : expiresWithin === '120' ? 120 : null
  const leases = window
    ? allLeases.filter((lease) => {
        const days = daysUntilExpiry(
          lease.endsOn ? utcToBusinessDate(lease.endsOn) : null,
          businessDate(now, lease.property.timezone),
        )
        return expiryWindow(days) !== null && expiryWindow(days)! <= window
      })
    : allLeases

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
            className="border-input hover:bg-secondary focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            New lease
          </Link>
        )}
      </header>

      {window && (
        <p className="text-muted-foreground text-sm">
          Showing {leases.length} of {allLeases.length} leases expiring within {window} days.{' '}
          <Link href="/leases" className="underline underline-offset-2">
            Clear filter
          </Link>
        </p>
      )}

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
                  className="hover:bg-secondary focus-visible:ring-ring flex min-h-14 flex-col gap-1 rounded-md px-2 py-3 focus-visible:ring-2 focus-visible:outline-none"
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
                    {friendlyBusinessDate(utcToBusinessDate(lease.startsOn))}
                    {lease.endsOn
                      ? ` to ${friendlyBusinessDate(utcToBusinessDate(lease.endsOn))}`
                      : ' (month-to-month)'}
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
