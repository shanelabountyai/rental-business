import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { auditFilters, platformAuditRows } from '@/lib/platform/audit.ts'
import { INPUT_CLASSES, SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform audit log' }

// PRD 11 §4.9 (R-303b). Filters are a plain GET form, so the URL is the
// filter and the CSV link carries the same query.
const SHOWN = 200

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePlatform({ permission: 'platformAudit.read' })
  const filters = auditFilters(await searchParams)
  const [rows, admins, orgs, actions] = await Promise.all([
    platformAuditRows(filters, SHOWN),
    prisma.platformAdmin.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.organization.findMany({ select: { slug: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.auditLog.findMany({ where: { actorType: 'PLATFORM' }, select: { action: true }, distinct: ['action'], orderBy: { action: 'asc' } }),
  ])
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Platform audit log</h1>
        <p className="text-muted-foreground text-sm">
          Every act by a platform admin, in any organisation or none. What an organisation&apos;s own staff do is not here.
        </p>
        <a href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </a>
      </header>

      <form method="get" className="grid grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-2">
        <Filter label="Admin" name="admin" value={filters.admin} options={admins.map((a) => [a.id, a.name])} />
        <Filter
          label="Organisation"
          name="org"
          value={filters.org}
          options={[['none', 'No organisation'], ...orgs.map((o): [string, string] => [o.slug, o.name])]}
        />
        <Filter label="Action" name="action" value={filters.action} options={actions.map((a) => [a.action, a.action])} />
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
          <a href={`/platform/audit/export${query ? `?${query}` : ''}`} className="text-sm underline underline-offset-4">
            Download these rows as CSV
          </a>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm">No platform acts match.</p>
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
                  {friendlyTimestamp(row.occurredAt, 'UTC')} · {row.admin?.name ?? row.actorRef ?? 'unknown admin'}
                  {' · '}
                  {row.organization ? (
                    <Link href={`/platform/orgs/${row.organization.slug}`} className="underline underline-offset-4">
                      {row.organization.name}
                    </Link>
                  ) : (
                    'no organisation'
                  )}
                </span>
                <span className="text-muted-foreground">
                  {row.entityType} {row.entityId}
                </span>
                {row.reason && <span>Reason: {row.reason}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  )
}

function Filter({ label, name, value, options }: { label: string; name: string; value: string; options: [string, string][] }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={value} className={`${INPUT_CLASSES} w-full`}>
        <option value="">Any</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
}
