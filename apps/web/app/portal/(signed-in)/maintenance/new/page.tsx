import Link from 'next/link'
import { MaintenanceWizard } from '@/components/portal/maintenance/maintenance-wizard.tsx'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { getTenantCurrentHome } from '@/lib/maintenance/queries.ts'

export const metadata = { title: 'Report a problem' }

// MAINT-01: "under 2 minutes end to end." The guard and the "do we even have
// a home to file this against" check happen here, server-side, before any
// client JS loads - so a tenant with no lease on file sees a plain
// explanation immediately rather than a wizard that would fail at the very
// last step.
export default async function NewMaintenanceRequestPage() {
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
      <MaintenanceWizard />
    </div>
  )
}
