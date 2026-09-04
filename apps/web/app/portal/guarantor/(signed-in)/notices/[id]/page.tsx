import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { markNoticeRead } from '@/lib/notices/actions.ts'
import { listTenantNotices } from '@/lib/notices/queries.ts'
import { requireGuarantorWithScope } from '@/lib/portal/guarantor-guard.ts'

export const metadata = { title: 'About this lease' }

// R-165, ROLE-01: scoped the same way the tenant notice page is - fetched
// pre-scoped by leaseId, then a miss is notFound() (404), never a refusal
// (403), so "not yours" and "does not exist" stay indistinguishable.
//
// markNoticeRead is the identical function the tenant page calls. It marks
// the PORTAL delivery read, not "read by this particular person" - a
// limitation worth stating rather than hiding: whichever of the tenant or
// the guarantor opens it first is who the read receipt records.
// ponytail: a per-recipient read receipt would need its own column on
// NoticeDelivery; add it if a dispute ever turns on which of them read it.

export default async function GuarantorNoticePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { leaseId } = await requireGuarantorWithScope()

  const notices = await listTenantNotices([leaseId])
  const notice = notices.find((row) => row.id === id)
  if (!notice) notFound()

  await markNoticeRead(notice.id, [leaseId])

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/portal/guarantor/notices"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Notices
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">About this lease</h1>
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
