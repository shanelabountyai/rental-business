import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SectionPlaceholder } from '@/components/shell/section-placeholder.tsx'

export const metadata = { title: 'Leases — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
export default async function LeasesPage() {
  const actor = await requirePermission('lease.read')
  const scope = await currentScope(actor)

  return (
    <SectionPlaceholder
      title="Leases"
      ownedBy="R-016"
      description="Tenancies, parties, terms and renewals."
      scopeSummary={`In scope right now: ${scope.propertyIds.length} propert${
        scope.propertyIds.length === 1 ? 'y' : 'ies'
      }.`}
    />
  )
}
