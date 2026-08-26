import Link from 'next/link'
import {
  MaintenanceWizard,
  type WizardParams,
} from '@/components/portal/maintenance/maintenance-wizard.tsx'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { getTenantCurrentHome } from '@/lib/maintenance/queries.ts'

export const metadata = { title: 'Report a problem' }

// MAINT-01: "under 2 minutes end to end." The guard and the "do we even have
// a home to file this against" check happen here, server-side, before any
// client JS loads - so a tenant with no lease on file sees a plain
// explanation immediately rather than a wizard that would fail at the very
// last step.
export default async function NewMaintenanceRequestPage({
  searchParams,
}: {
  searchParams: Promise<WizardParams>
}) {
  // The wizard's answers live in the query string (R-111), so that pressing
  // Next before the page has hydrated - or with no JavaScript at all - is an
  // ordinary navigation rather than a tap that does nothing. Everything that
  // arrives here is clamped by `reachableStep` in the wizard itself; nothing
  // in this object is trusted.
  const initial = await searchParams
  const { scope } = await requireTenantWithScope()
  const home = await getTenantCurrentHome(scope)

  if (!home) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Report a problem</h1>
        <p>
          We do not have a home on file for you yet. Please{' '}
          <Link
            href="/portal/messages"
            className="focus-visible:ring-ring rounded-md underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            send us a message
          </Link>{' '}
          instead, or call or text the number on your lease.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Report a problem</h1>
      {/*
        An escape hatch at the top of the ordinary flow, not buried at the
        bottom: a tenant who starts here and only then realises how bad it is
        needs one tap to the emergency path, not a scroll (R-020).
      */}
      <Link
        href="/portal/maintenance/emergency"
        className="focus-visible:ring-ring flex min-h-12 items-center rounded-md border-2 border-red-600 bg-red-50 px-4 py-2 text-base font-medium text-red-950 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Is this an emergency? Gas, flooding, no heat, break-in →
      </Link>
      <MaintenanceWizard initial={initial} />
    </div>
  )
}
