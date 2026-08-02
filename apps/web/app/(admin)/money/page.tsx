import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SectionPlaceholder } from '@/components/shell/section-placeholder.tsx'

export const metadata = { title: 'Money — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
export default async function MoneyPage() {
  const actor = await requirePermission('ledger.read')
  const scope = await currentScope(actor)

  return (
    <SectionPlaceholder
      title="Money"
      ownedBy="R-035"
      description="The rent roll, the per-lease ledger projection and delinquency aging (PAY-03, PAY-06)."
      scopeSummary={`In scope right now: ${scope.propertyIds.length} propert${
        scope.propertyIds.length === 1 ? 'y' : 'ies'
      }.`}
    />
  )
}
