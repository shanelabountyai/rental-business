import { CATEGORY_LABELS, MAINTENANCE_CATEGORIES } from '@rental/core/maintenance'
import { LogPhoneRequestForm } from '@/components/maintenance/log-phone-request-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { logPhoneMaintenanceRequest } from '@/lib/maintenance/actions.ts'
import { listLoggableLeaseTenants } from '@/lib/maintenance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Log a phone-reported request — Rental Operations' }

const CATEGORY_OPTIONS = MAINTENANCE_CATEGORIES.map((category) => ({
  value: category,
  label: CATEGORY_LABELS[category],
}))

// requireScope, not a bare requirePermission: "may this actor log a request
// for ANYONE" (same shape as /tasks/new). The specific lease picked in the
// form is re-checked by logPhoneMaintenanceRequest() itself (R-022).
export default async function NewPhoneRequestPage() {
  const { actor } = await requireScope('ticket.write')
  const scope = await currentScope(actor)
  const leaseTenants = await listLoggableLeaseTenants(scope)

  const callers = leaseTenants.map((lt) => ({
    id: lt.id,
    label: `${lt.lease.property.name} — ${lt.lease.unit.name} — ${lt.tenant.firstName} ${lt.tenant.lastName}${lt.tenant.phone ? ` (${lt.tenant.phone})` : ''}`,
  }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Log a phone-reported request
      </h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        A tenant who called instead of using the portal is not a
        second-class record - this becomes the same kind of ticket as one
        submitted online or by text (MAINT-01).
      </p>
      <LogPhoneRequestForm
        action={logPhoneMaintenanceRequest}
        callers={callers}
        categories={CATEGORY_OPTIONS}
      />
    </div>
  )
}
