import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { Badge } from '@/components/badge.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { listTenantNotices } from '@/lib/notices/queries.ts'
import { requireGuarantorWithScope } from '@/lib/portal/guarantor-guard.ts'

export const metadata = { title: 'Notices about this lease' }

// COMM-02/R-165: notices served on the lease this guarantor guarantees.
//
// SAME QUERY AS THE TENANT PORTAL - `listTenantNotices` takes a lease id
// list, not a tenant id, so a guarantor's single leaseId scopes it exactly
// the way a tenant's does. The demand ladder is already addressed to the
// guarantor alongside the tenant (see notices/actions.ts's recipientNames),
// so this is the same set of served notices the tenant on this lease sees.

export default async function GuarantorNoticesPage() {
  const { leaseId } = await requireGuarantorWithScope()
  const notices = await listTenantNotices([leaseId])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Notices about this lease">
        <p className="text-muted-foreground text-sm">
          Letters served on this tenancy. Opening one records that you have seen
          it.
        </p>
      </PageHeader>

      {notices.length === 0 ? (
        <p className="text-muted-foreground text-sm">No notices.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {notices.map((notice) => {
            const unread = notice.deliveries.some((d) => d.readAt == null)
            return (
              <li key={notice.id}>
                <Link
                  href={`/portal/guarantor/notices/${notice.id}`}
                  className="hover:bg-secondary focus-visible:ring-ring flex min-h-14 flex-col gap-1 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">About this lease</span>
                    {unread && <Badge tone="warning">New</Badge>}
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
