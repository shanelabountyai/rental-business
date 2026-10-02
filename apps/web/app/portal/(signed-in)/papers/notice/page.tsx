import { friendlyDate } from '@rental/core/scheduling'
import { PageHeader } from '@/components/page-header.tsx'
import { NoticeToVacateForm } from '@/components/portal/notice-to-vacate-form.tsx'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { submitNoticeToVacate } from '@/lib/portal/notice-to-vacate-actions.ts'
import { getTenantHome } from '@/lib/portal/queries.ts'

export const metadata = { title: 'Give notice to vacate' }

// A tenant's own notice to vacate (LEASE-11, R-066) - D-10's plain word,
// "notice", never "termination" or "vacate" as a verb aimed at the reader.
//
// Guarded by requireTenantWithScope() - a real session, so this needs no
// public-token machinery the way a stranger-facing form would.

export default async function NoticeToVacatePage() {
  const { scope } = await requireTenantWithScope()
  const home = await getTenantHome(scope)

  if (!home) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Give notice" />
        <p>We do not have a home on file for you yet. Send us a message instead.</p>
      </div>
    )
  }

  if (home.noticeGivenAt) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Notice already on file" />
        <p>
          {home.noticeGivenBy === 'TENANT'
            ? `You gave notice on ${friendlyDate(home.noticeGivenAt, home.property.timezone)}`
            : `We gave notice on ${friendlyDate(home.noticeGivenAt, home.property.timezone)}`}
          {home.noticeEffectiveOn &&
            ` - your tenancy ends ${friendlyDate(home.noticeEffectiveOn, home.property.timezone)}`}
          .
        </p>
        <p>Contact us if anything about your move-out date has changed.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Give notice to vacate">
        <p>
          Tell us when you plan to move out of {home.property.addressLine1}
          {home.unit.name ? ` (${home.unit.name})` : ''}. Rent is still due, and any repairs
          are still owed, until you actually leave.
        </p>
      </PageHeader>
      <NoticeToVacateForm action={submitNoticeToVacate} />
    </div>
  )
}
