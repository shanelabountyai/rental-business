import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SectionPlaceholder } from '@/components/shell/section-placeholder.tsx'

export const metadata = { title: 'Maintenance — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
export default async function MaintenancePage() {
  const actor = await requirePermission('ticket.read')
  const scope = await currentScope(actor)

  return (
    <SectionPlaceholder
      title="Maintenance"
      ownedBy="R-022"
      description="Requests from tenants, triage, and the work orders they become (MAINT-01, MAINT-02)."
      scopeSummary={`In scope right now: ${scope.propertyIds.length} propert${
        scope.propertyIds.length === 1 ? 'y' : 'ies'
      }.`}
    />
  )
}
