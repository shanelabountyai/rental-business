import { prisma } from '@rental/db'
import type { CronChild } from '@/lib/cron/org-health.ts'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'
import { rerunCronChild } from '@/lib/platform/job-actions.ts'
import { healthIsStale } from '@/lib/platform/orgs.ts'
import { HealthFreshness, runOutcome } from '@/components/platform/org-health.tsx'
import { RerunButton } from '@/components/platform/rerun-button.tsx'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Jobs' }

// PRD 11 §4.10 (R-303b). From `OrgHealth` only (D-354): counts, outcomes and
// timestamps, never `JobRun.error` or `result`, which are free text that can
// name a tenant and stay behind a grant on the org's own `/jobs` page.

const CHILDREN: { child: CronChild; label: string }[] = [
  { child: 'daily', label: 'Daily run' },
  { child: 'notifications', label: 'Notification run' },
  { child: 'escalations', label: 'Escalation run' },
]

type Health = NonNullable<Awaited<ReturnType<typeof loadOrgs>>[number]['health']>

const loadOrgs = () =>
  prisma.organization.findMany({ select: { id: true, slug: true, name: true, health: true }, orderBy: { name: 'asc' } })

const outcomeOf = (h: Health, child: CronChild) =>
  ({ at: h[`${child}At`], ok: h[`${child}Ok`] }) as { at: Date | null; ok: boolean | null }

/// Worst first: no health at all or stale, then failed children, then failed
/// runs in the week, then dead letters. Name breaks ties (the query's order).
function severity(health: Health | null, now: Date): number[] {
  if (healthIsStale(health, now)) return [1, 0, 0, 0]
  const h = health!
  return [0, CHILDREN.filter(({ child }) => outcomeOf(h, child).ok === false).length, h.failedRuns7d, h.deadLetters]
}

function byWorst(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!
  return 0
}

function age(at: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - at.getTime()) / 3_600_000)
  return hours < 1 ? 'under an hour ago' : hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}

export default async function PlatformJobsPage() {
  const admin = await requirePlatform({ permission: 'org.read' })
  const canRerun = (await platformDecision(admin, 'job.rerun')).allowed
  const now = new Date()
  const orgs = (await loadOrgs())
    .map((org) => ({ org, rank: severity(org.health, now) }))
    .sort((a, b) => byWorst(a.rank, b.rank))
    .map(({ org }) => org)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="text-muted-foreground text-sm">
          Every organisation&apos;s cron runs, worst first. Error text stays on the organisation&apos;s own jobs page,
          behind a grant.
          {canRerun && ' A re-run is the request the schedule makes: it does nothing if today’s daily run already succeeded.'}
        </p>
        <a href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </a>
      </header>
      {orgs.length === 0 ? (
        <p className="text-sm">No organisations yet.</p>
      ) : (
        orgs.map((org) => {
          const fresh = !healthIsStale(org.health, now) && org.health
          return (
            <section key={org.id} aria-label={org.name} className="flex flex-col gap-3 rounded-md border p-4 text-sm break-words">
              <h2 className="text-lg font-semibold">
                <Link href={`/platform/orgs/${org.slug}`} className="underline underline-offset-4">
                  {org.name}
                </Link>
              </h2>
              <p className="text-muted-foreground">
                <HealthFreshness health={org.health} now={now} />
                {fresh && (
                  <>
                    {' '}
                    · {fresh.failedRuns7d} failed in 7 days · {fresh.deadLetters} dead-lettered · {fresh.heldNotifications}{' '}
                    held for quiet hours
                  </>
                )}
              </p>
              <ul className="flex flex-col gap-3">
                {CHILDREN.map(({ child, label }) => {
                  const run = fresh ? outcomeOf(fresh, child) : null
                  return (
                    <li key={child} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-medium">{label}:</span>{' '}
                        {run ? runOutcome(run.at, run.ok) : 'not reported'}
                        {run?.at && ` (${age(run.at, now)})`}
                      </span>
                      {canRerun && (
                        <RerunButton action={rerunCronChild} orgId={org.id} child={child} label={`${label.toLowerCase()} for ${org.name}`} />
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })
      )}
    </main>
  )
}
