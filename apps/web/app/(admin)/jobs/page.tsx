import { friendlyBusinessDate, friendlyTimestamp } from '@rental/core/scheduling'
import { requirePermission } from '@/lib/auth/guard.ts'
// Side-effect import: populates SCHEDULED_JOBS before `jobHealth()` reads it.
// See registrations.ts for why every job module is imported from exactly here.
import '@/lib/jobs/registrations.ts'
import { jobHealth } from '@/lib/jobs/queries.ts'
import { RerunForm } from '@/components/jobs/rerun-form.tsx'

export const metadata = { title: 'Scheduled jobs — Rental Operations' }

/**
 * Scheduled-job health (R-174).
 *
 * ==========================================================================
 * THE SCREEN EXISTS BECAUSE NOTHING READ `JobRun`.
 *
 * The runner has written a row per job per property per day since R-006, and
 * until now the only thing that ever read one back was the digest job asking
 * when it last ran. A failed run was recorded, audited, and then seen by
 * nobody; a missed day was not recorded at all. Four of the jobs standing on
 * that silence run legal clocks - deposit-disposition reminders, court-date
 * reminders, the case stall sweep, the billing sweep - so "the cron was down
 * on Tuesday" and "nobody was reminded of a hearing" were the same sentence
 * and neither was ever said out loud.
 * ==========================================================================
 *
 * `requirePermission('job.manage')` with NO resource. permissions.ts calls
 * that the correct guard rather than a bug for a portfolio-wide destination:
 * there is no single record "did last night's work happen everywhere" checks
 * against, and a property-scoped actor cannot pass it - which is why the nav
 * entry is `portfolioOnly`.
 *
 * No `loading.tsx` anywhere near this segment, deliberately: one two directories
 * up turns every `notFound()` beneath it into an HTTP 200 (R-099).
 */
export default async function JobsPage() {
  await requirePermission('job.manage')
  const jobs = await jobHealth()

  const failing = jobs.filter((job) => job.failed.length > 0)
  const overdue = jobs.filter(
    (job) => job.overdueToday.length > 0 || job.missedDates.length > 0,
  )
  const neverRun = jobs.filter((job) => job.lastSuccessAt == null)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Scheduled jobs</h1>
        <p className="text-muted-foreground text-sm">
          The nightly work, per job. Times are UTC — each job actually fires at
          its own hour in each property&rsquo;s local day.
        </p>
      </header>

      {failing.length === 0 && overdue.length === 0 && neverRun.length === 0 ? (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Every scheduled job has run successfully and nothing is overdue.
        </p>
      ) : (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {summarise(failing.length, overdue.length, neverRun.length)}
        </p>
      )}

      <ul className="flex flex-col gap-4">
        {jobs.map((job) => (
          <li key={job.type} className="flex flex-col gap-3 rounded-md border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">{job.description}</h2>
              <span className="text-muted-foreground font-mono text-xs">
                {job.type} · {String(job.localHour).padStart(2, '0')}:00 local
              </span>
            </div>

            <p className="text-sm">
              {job.lastSuccessAt ? (
                <>
                  Last succeeded {friendlyTimestamp(job.lastSuccessAt, 'UTC')}.
                </>
              ) : (
                <span className="font-medium text-red-800">
                  Has never completed successfully anywhere.
                </span>
              )}
            </p>

            {job.overdueToday.length > 0 && (
              <p className="text-sm text-amber-900">
                Due today and not yet run at{' '}
                {job.overdueToday.map((p) => p.propertyName).join(', ')}.
              </p>
            )}

            {job.missedDates.length > 0 && (
              <p className="text-sm text-amber-900">
                Missed, and now outside the catch-up window:{' '}
                {job.missedDates
                  .map(
                    (miss) =>
                      `${miss.propertyName} on ${friendlyBusinessDate(miss.date)}`,
                  )
                  .join('; ')}
                .
              </p>
            )}

            {job.failed.length > 0 && (
              <ul className="flex flex-col gap-3 divide-y">
                {job.failed.map((run) => (
                  <li key={run.id} className="flex flex-col gap-2 pt-3 first:pt-0">
                    <p className="text-sm font-medium text-red-900">
                      Failed at {run.propertyName} for{' '}
                      {friendlyBusinessDate(run.businessDate)} — attempt{' '}
                      {run.attempts}
                    </p>
                    {run.error && (
                      <p className="text-muted-foreground font-mono text-xs break-words">
                        {run.error}
                      </p>
                    )}
                    <RerunForm
                      jobRunId={run.id}
                      label={`${job.description} at ${run.propertyName} for ${friendlyBusinessDate(run.businessDate)}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {jobs.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No scheduled jobs are registered in this deployment.
        </p>
      )}
    </div>
  )
}

function summarise(failing: number, overdue: number, neverRun: number): string {
  const parts: string[] = []
  if (failing > 0) {
    parts.push(`${failing} job${failing === 1 ? ' has' : 's have'} failed runs`)
  }
  if (overdue > 0) {
    parts.push(`${overdue} ${overdue === 1 ? 'is' : 'are'} overdue or missed a day`)
  }
  if (neverRun > 0) {
    parts.push(`${neverRun} ${neverRun === 1 ? 'has' : 'have'} never run at all`)
  }
  return `${parts.join(', ')}.`
}
