import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { OrgExportForm, OrgFreezeForm } from '@/components/export/org-export-form.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { freezeOwnOrganization, startOrgExport } from '@/lib/export/actions.ts'
import { ORG_EXPORT_JOB, ORG_EXPORT_TTL_MS } from '@/lib/export/org-export.ts'
import { orgTimezone } from '@/lib/support/grants.ts'

export const metadata = { title: 'Export your data' }

// PRD 10 §8 (R-299): the organisation's own copy of everything it holds.
// Owner-only, the same three permissions the action and the download check.

const STATUS = { RUNNING: 'Being made', SUCCEEDED: 'Ready', FAILED: 'Failed' } as const

export default async function OrgExportPage() {
  const actor = await requirePermission('report.financial')
  await requirePermission('property.export')
  await requirePermission('audit.read')
  const [org, runs, zone] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { slug: true, status: true, offboardAt: true } }),
    prisma.jobRun.findMany({
      where: { orgId: actor.orgId, jobType: ORG_EXPORT_JOB },
      select: { id: true, status: true, startedAt: true, finishedAt: true, error: true, result: true },
      orderBy: { startedAt: 'desc' },
      take: 10,
    }),
    orgTimezone(actor.orgId),
  ])
  const now = new Date().getTime()

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Export your data">
        <p className="text-muted-foreground text-sm">
          One zip of every record your organisation holds: a spreadsheet per table, every stored document and
          evidence packet, and a manifest of row counts. Passwords, codes and other credentials are blanked. One
          export a day; each download link works for 7 days.
        </p>
      </PageHeader>
      <OrgExportForm action={startOrgExport} />
      <section aria-labelledby="exports-heading" className="flex flex-col gap-3">
        <h2 id="exports-heading" className="text-lg font-semibold">
          Your exports
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm">No export has been made yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm break-words">
            {runs.map((run) => {
              const sizeBytes = (run.result as { sizeBytes?: number } | null)?.sizeBytes
              const live = run.status === 'SUCCEEDED' && run.finishedAt && now - run.finishedAt.getTime() <= ORG_EXPORT_TTL_MS
              return (
                <li key={run.id} className="flex flex-col gap-1 rounded-lg border border-border p-3">
                  <p className="font-medium">
                    {STATUS[run.status]} — started {friendlyTimestamp(run.startedAt, zone)}
                  </p>
                  {run.status === 'FAILED' && <p>{run.error ?? 'No error recorded.'} Try again.</p>}
                  {live && (
                    <a className="underline" href={`/api/org-export/${run.id}`}>
                      Download the export of {friendlyTimestamp(run.startedAt, zone)}
                      {sizeBytes ? ` (${(sizeBytes / 1_048_576).toFixed(1)} MB)` : ''}
                    </a>
                  )}
                  {run.status === 'SUCCEEDED' && !live && <p className="text-muted-foreground">Link expired.</p>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="freeze-heading" className="flex flex-col gap-3">
        <h2 id="freeze-heading" className="text-lg font-semibold">
          Freeze this organisation
        </h2>
        {org.status === 'FROZEN' ? (
          <p className="text-sm break-words">
            Frozen. Everyone can still read and export; nothing can be changed, scheduled jobs are stopped and rent
            collection is paused. Only platform support can restore it.
            {org.offboardAt && ` Its data is scheduled for removal on or after ${friendlyTimestamp(org.offboardAt, zone)}.`}
          </p>
        ) : org.status === 'ACTIVE' ? (
          <>
            <p className="text-sm">
              For leaving the service. Everyone keeps read access and can still export, but nothing can be changed,
              scheduled jobs stop and rent collection is paused (subscriptions are paused, not cancelled). You cannot
              undo it yourself: only platform support can restore it.
            </p>
            <OrgFreezeForm action={freezeOwnOrganization} slug={org.slug} />
          </>
        ) : (
          <p className="text-sm">An organisation still being set up cannot be frozen.</p>
        )}
      </section>
    </div>
  )
}
