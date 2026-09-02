import { formatCents } from '@rental/core/money'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'

// What maintenance has cost at this property (MAINT-07, R-030).
//
// The "flows to reporting" half of "work order → invoice → P&L is one chain,
// no re-keying". Every number here is read off the work orders themselves —
// there is no maintenance-spend table, because a second store of the same
// money is the thing that drifts. R-042's QuickBooks export maps from the
// same rows.
//
// A server component: it renders numbers and links and has no state, so
// shipping a client bundle for it would be pure weight.

export interface ClosedJob {
  id: string
  scope: string
  closedAt: Date | null
  totalCents: number
  tenantCaused: boolean
  vendorName: string | null
  unitName: string
}

export function MaintenanceSpendSection({
  jobs,
  timeZone,
}: {
  jobs: ClosedJob[]
  /// `closedAt` is an instant, so it reads in the PROPERTY's zone - a job
  /// closed at 7pm in Houston is not a next-day job.
  timeZone: string
}) {
  const total = jobs.reduce((sum, job) => sum + job.totalCents, 0)
  // Split out because it is the number that answers a different question:
  // what the property cost to run, versus what should be billed back to a
  // tenant (R-031 posts that charge; this only reports it).
  const tenantCaused = jobs
    .filter((job) => job.tenantCaused)
    .reduce((sum, job) => sum + job.totalCents, 0)

  return (
    <section className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">Maintenance spend</h2>
        {/* SAYS WHAT IT COVERS (R-032e, D-42). `closedJobCostsForProperty`
            takes no period and no entity filter, so this is every closed job
            since the property was added — and an unlabelled total on a
            property page reads like an annual figure somebody re-keys into a
            spreadsheet, which is the re-keying D-19 exists to prevent.
            Per-period and per-entity reporting is the operating report's
            (R-081a); this is still a tile, and now it says where the real
            report lives instead of only saying it does not exist. */}
        <p className="text-muted-foreground text-xs">
          Every job closed since this property was added — not a period or
          entity report. For a year, by trade, beside income and vacancy, see
          the{' '}
          <Link href="/reports/operating" className="underline underline-offset-2">
            operating report
          </Link>
          .
        </p>
      </div>

      {jobs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No work orders closed here yet. Costs land here as jobs close — they
          are never entered twice.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Closed jobs</dt>
            <dd>{jobs.length}</dd>
            <dt className="text-muted-foreground">Total</dt>
            <dd>{formatCents(total)}</dd>
            {tenantCaused > 0 && (
              <>
                <dt className="text-muted-foreground">Of which tenant-caused</dt>
                <dd>{formatCents(tenantCaused)}</dd>
              </>
            )}
          </dl>

          <ul className="flex flex-col divide-y text-sm">
            {jobs.slice(0, 10).map((job) => (
              <li key={job.id} className="py-2">
                <Link
                  href={`/workorders/${job.id}`}
                  className="hover:bg-secondary focus-visible:ring-ring flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md px-2 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="flex flex-col">
                    <span>{job.scope}</span>
                    <span className="text-muted-foreground text-xs">
                      {job.unitName}
                      {job.vendorName && ` · ${job.vendorName}`}
                      {job.closedAt && ` · ${friendlyDate(job.closedAt, timeZone)}`}
                      {job.tenantCaused && ' · tenant-caused'}
                    </span>
                  </span>
                  <span>{formatCents(job.totalCents)}</span>
                </Link>
              </li>
            ))}
          </ul>

          {/* No backlog id in the copy. An owner reading "R-050" learns
              nothing and is being shown our issue tracker; what they need to
              know is that this list is partial and that no date range has been
              applied to it. */}
          {jobs.length > 10 && (
            <p className="text-muted-foreground text-xs">
              Showing the 10 most recent of {jobs.length} closed jobs, all time.
              The operating report filters by year.
            </p>
          )}
        </>
      )}
    </section>
  )
}
