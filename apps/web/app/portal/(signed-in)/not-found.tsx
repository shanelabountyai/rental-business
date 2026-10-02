import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// The tenant's 404 (U1, R-099).
//
// Fourteen pages across the product call `notFound()` and none of them had a
// screen to land on, so a tenant following a stale link out of an old text
// message got Next's bare 404: black on white, no navigation, no way back.
//
// Reached most often for a reason worth naming: a maintenance request or a
// message that belongs to somebody else. Both `/portal/maintenance/[id]` and
// `/portal/messages/[id]` deliberately call `notFound()` rather than
// "forbidden" when the record is not this tenant's — a 403 confirms the
// record exists, which is itself a leak. So the wording has to be honest for
// BOTH cases at once without hinting which one happened.

export default function PortalNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="We could not find that" />

      <p className="text-base">
        The link may be old, or it may point at something that is not part of
        your home. Nothing is wrong with your account.
      </p>

      <Link
        href="/portal"
        className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 w-full items-center justify-center px-6 py-2 text-base sm:w-auto`}
      >
        Go to your home page
      </Link>

      <p className="text-base">
        If you got here from a text or an email we sent and it should have
        worked, call or text the number on your lease and we will send a new
        link.
      </p>
    </div>
  )
}
