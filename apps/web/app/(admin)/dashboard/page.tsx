import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SectionPlaceholder } from '@/components/shell/section-placeholder.tsx'

export const metadata = { title: 'Dashboard — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
export default async function DashboardPage() {
  const actor = await requirePermission('property.read')
  const scope = await currentScope(actor)

  return (
    <SectionPlaceholder
      title="Dashboard"
      ownedBy="R-013"
      description="Rent collected against billed, aged delinquency, open work by priority and age, vacancies, leases expiring, pending approvals and compliance dates - every tile drilling into the filtered list behind it (RPT-01)."
      scopeSummary={`In scope right now: ${scope.propertyIds.length} propert${
        scope.propertyIds.length === 1 ? 'y' : 'ies'
      }.`}
    />
  )
}
