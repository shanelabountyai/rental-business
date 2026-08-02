import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SectionPlaceholder } from '@/components/shell/section-placeholder.tsx'

export const metadata = { title: 'Properties — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
export default async function PropertiesPage() {
  const actor = await requirePermission('property.read')
  const scope = await currentScope(actor)

  return (
    <SectionPlaceholder
      title="Properties"
      ownedBy="R-008"
      description="Legal entities and properties: address, timezone and state, acquisition date, entity assignment (PROP-01, PROP-04)."
      scopeSummary={`In scope right now: ${scope.propertyIds.length} propert${
        scope.propertyIds.length === 1 ? 'y' : 'ies'
      }.`}
    />
  )
}
