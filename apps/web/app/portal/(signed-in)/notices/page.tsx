import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { listTenantNotices } from '@/lib/notices/queries.ts'

export const metadata = { title: 'Your notices' }

// COMM-02: notices served to this tenant, and only theirs.
//
// The enforcement is in `listTenantNotices`, which filters by lease in the
// query. Nothing on this page decides access - a template that hides rows has
// already sent them.
//
// D-10's lexicon: plain words, no "service", no "delivery", no notice-type
// enum. A tenant reads "About your home" and a date; the machinery behind it
// is staff vocabulary.

export default async function PortalNoticesPage() {
  const { scope } = await requireTenantWithScope()
  const notices = await listTenantNotices(scope.leaseIds)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your notices</h1>
        <p className="text-muted-foreground text-sm">
          Letters we have sent you about your home. Opening one tells us you have
          seen it.
        </p>
      </header>

      {notices.length === 0 ? (
        <p className="text-muted-foreground text-sm">You have no notices.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {notices.map((notice) => {
            const unread = notice.deliveries.some((d) => d.readAt == null)
            return (
              <li key={notice.id}>
                <Link
                  href={`/portal/notices/${notice.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col gap-1 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">About your home</span>
                    {unread && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                        New
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {notice.servedAt
                      ? friendlyDate(notice.servedAt, notice.property.timezone)
                      : ''}
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
