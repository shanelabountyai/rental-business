import { durationLabel } from '@rental/core/rbac'
import { friendlyTimestamp } from '@rental/core/scheduling'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { INPUT_CLASSES, SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { requireScope } from '@/lib/auth/guard.ts'
import { ACTOR_TYPES, grantHeader, orgAuditFilters, orgAuditRows, orgAuditWhere } from '@/lib/audit/org-log.ts'
import { orgTimezone } from '@/lib/support/grants.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Audit log' }

// PRD 11 §4.15 (R-295b): every audited act in this organisation the reader
// can see, newest first, including every act by platform support. Filters
// are a plain GET form, so the URL is the filter and the CSV link carries it.
// No page views: reads are not audit events anywhere in this product (§6),
// so a grant's "what was viewed" is its window plus every row under it.

const SHOWN = 200
const ACTOR_LABEL: Record<(typeof ACTOR_TYPES)[number], string> = {
  STAFF: 'Staff',
  TENANT: 'Tenants',
  GUARANTOR: 'Guarantors',
  VENDOR: 'Vendors',
  SYSTEM: 'System jobs',
  PLATFORM: 'Platform support',
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { actor, scope } = await requireScope('audit.read')
  const filters = orgAuditFilters(await searchParams)
  const zone = await orgTimezone(actor.orgId)
  const where = orgAuditWhere(actor, scope, filters, zone)
  const [rows, grant] = await Promise.all([
    where ? orgAuditRows(where, SHOWN) : [],
    filters.grant ? grantHeader(filters.grant, actor.orgId) : null,
  ])
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Audit log">
        <p className="text-muted-foreground text-sm">
          Every recorded change in your organisation, including everything platform support did under a grant. Times are shown
          in {zone}.
        </p>
      </PageHeader>

      {filters.grant && (
        <section aria-labelledby="grant-heading" className="flex flex-col gap-1 rounded-md border p-4 text-sm break-words">
          <h2 id="grant-heading" className="font-semibold">
            Under one support grant
          </h2>
          {grant ? (
            <>
              <p>
                {grant.kind === 'BREAK_GLASS' ? 'Emergency access' : 'Request'} by {grant.platformAdmin.name}
                {grant.approvedBy ? `, approved by ${grant.approvedBy.name}` : ''}.
              </p>
              <p>Reason: {grant.reason}</p>
              <p>
                {grant.startsAt && grant.expiresAt
                  ? `Open from ${friendlyTimestamp(grant.startsAt, zone)} for ${durationLabel(Math.round((grant.expiresAt.getTime() - grant.startsAt.getTime()) / 60_000))}${grant.endedAt ? `, ended ${friendlyTimestamp(grant.endedAt, zone)}` : ''}.`
                  : 'It never opened.'}
              </p>
              <p className="text-muted-foreground">
                Page views are not recorded, so what support could see is everything in this window; what it did is below.
              </p>
            </>
          ) : (
            <p>No grant of this organisation matches that link.</p>
          )}
          <Link href="/settings/audit" className="self-start underline underline-offset-4">
            Show every row
          </Link>
        </section>
      )}

      <form method="get" className="grid grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-2">
        {filters.grant && <input type="hidden" name="grant" value={filters.grant} />}
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          Who
          <select name="actor" defaultValue={filters.actor} className={`${INPUT_CLASSES} w-full`}>
            <option value="">Anyone</option>
            {ACTOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTOR_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
            From
            <input type="date" name="from" defaultValue={filters.from} className={INPUT_CLASSES} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
            To
            <input type="date" name="to" defaultValue={filters.to} className={INPUT_CLASSES} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" className={`${SUBMIT_BUTTON_CLASSES} min-h-11 px-4 py-2`}>
            Filter
          </button>
          <a href={`/settings/audit/export${query ? `?${query}` : ''}`} className="text-sm underline underline-offset-4">
            Download these rows as CSV
          </a>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm">Nothing recorded matches.</p>
      ) : (
        <>
          {rows.length === SHOWN && (
            <p className="text-sm">Showing the latest {SHOWN}. Narrow the filters, or download the CSV for every row.</p>
          )}
          <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 px-4 py-3 text-sm break-words">
                <span className="font-medium">{row.action}</span>
                <span>
                  {friendlyTimestamp(row.occurredAt, zone)} · {row.who}
                  {row.property ? ` · ${row.property.name}` : ''}
                </span>
                <span className="text-muted-foreground">
                  {row.href ? (
                    <Link href={row.href} className="underline underline-offset-4">
                      {row.entityType} {row.entityId}
                    </Link>
                  ) : (
                    `${row.entityType} ${row.entityId}`
                  )}
                </span>
                {row.reason && <span>Reason: {row.reason}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
