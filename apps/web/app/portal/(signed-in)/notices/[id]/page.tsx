import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { markNoticeRead } from '@/lib/notices/actions.ts'
import { listTenantNotices } from '@/lib/notices/queries.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'

export const metadata = { title: 'A notice about your home' }

// COMM-02's read receipt: opening this page IS the proof that portal service
// reached the tenant.
//
// ==========================================================================
// THE RECEIPT IS WRITTEN FROM THE TENANT'S OWN AUTHENTICATED VIEW, and from
// nowhere else. Not from an email open-pixel (blocked by every modern client
// and proves only that a proxy prefetched an image), not from a staff screen,
// and not from the list page - a list showing "About your home" is not the
// tenant reading the notice. This page renders the notice text itself, which
// is the only moment anybody can honestly say it was delivered.
//
// It is written BEFORE the render rather than in a fire-and-forget effect,
// because a receipt that depends on client-side JavaScript running is a
// receipt that is missing for exactly the tenant who disabled it - and
// `onClick` is inert until hydration anyway.
//
// Write-once at the database, so the second visit changes nothing. What is
// on the record is when they FIRST read it.
// ==========================================================================

export default async function PortalNoticePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { scope } = await requireTenantWithScope()

  // Scoped by the same query the list uses, so a notice belonging to somebody
  // else 404s rather than 403s - ROLE-01 answers 404 deliberately, so
  // "forbidden" cannot be used to confirm a record exists.
  const notices = await listTenantNotices(scope.leaseIds)
  const notice = notices.find((row) => row.id === id)
  if (!notice) notFound()

  await markNoticeRead(notice.id, scope.leaseIds)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/portal/notices"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Your notices
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">About your home</h1>
        <p className="text-muted-foreground text-sm">
          {notice.servedAt ? friendlyDate(notice.servedAt, notice.property.timezone) : ''}
        </p>
      </header>

      {notice.bodyText && (
        <pre className="bg-muted/50 overflow-x-auto rounded-md border p-4 text-sm whitespace-pre-wrap">
          {notice.bodyText}
        </pre>
      )}

      {notice.documentId && (
        <p className="text-sm">
          <a
            href={`/api/documents/${notice.documentId}/file`}
            className="underline underline-offset-4"
          >
            Download this notice
          </a>
        </p>
      )}

      <p className="text-muted-foreground text-sm">
        If you have questions about this, contact the office.
      </p>
    </div>
  )
}
