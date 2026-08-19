import { businessDate } from '@rental/core/scheduling'
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
        <h1 className="text-2xl font-semibold tracking-tight">Give notice</h1>
        <p>We do not have a home on file for you yet. Send us a message instead.</p>
      </div>
    )
  }

  if (home.noticeGivenAt) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Notice already on file</h1>
        <p>
          {home.noticeGivenBy === 'TENANT'
            ? `You gave notice on ${businessDate(home.noticeGivenAt, home.property.timezone)}`
            : `We gave notice on ${businessDate(home.noticeGivenAt, home.property.timezone)}`}
          {home.noticeEffectiveOn &&
            ` - your tenancy ends ${businessDate(home.noticeEffectiveOn, home.property.timezone)}`}
          .
        </p>
        <p>Contact us if anything about your move-out date has changed.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Give notice to vacate</h1>
        <p>
          Tell us when you plan to move out of {home.property.addressLine1}
          {home.unit.name ? ` (${home.unit.name})` : ''}. Rent is still due, and any repairs
          are still owed, until you actually leave.
        </p>
      </div>
      <NoticeToVacateForm action={submitNoticeToVacate} />
    </div>
  )
}
