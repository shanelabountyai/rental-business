import Link from 'next/link'
import { AddComplianceItemForm } from '@/components/compliance/add-item-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { createComplianceItem } from '@/lib/compliance/actions.ts'
import { complianceScopeOptions } from '@/lib/compliance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'New compliance item — Rental Operations' }

export default async function NewComplianceItemPage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const { properties, entities } = await complianceScopeOptions(scope)

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/compliance"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Compliance calendar
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New compliance item</h1>
      </header>

      {properties.length === 0 ? (
        <p className="text-muted-foreground text-sm">There are no properties in scope.</p>
      ) : (
        <AddComplianceItemForm action={createComplianceItem} properties={properties} entities={entities} />
      )}
    </div>
  )
}
