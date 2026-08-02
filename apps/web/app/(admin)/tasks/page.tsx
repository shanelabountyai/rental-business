import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SectionPlaceholder } from '@/components/shell/section-placeholder.tsx'

export const metadata = { title: 'Tasks — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
export default async function TasksPage() {
  const actor = await requirePermission('task.read')
  const scope = await currentScope(actor)

  return (
    <SectionPlaceholder
      title="Tasks"
      ownedBy="R-011"
      description="The one work queue (D-9): every staff queue in the product is a view over it."
      scopeSummary={`In scope right now: ${scope.propertyIds.length} propert${
        scope.propertyIds.length === 1 ? 'y' : 'ies'
      }.`}
    />
  )
}
