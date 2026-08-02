import { EntityForm } from '@/components/properties/entity-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { createLegalEntity } from '@/lib/properties/actions.ts'

export const metadata = { title: 'New legal entity — Rental Operations' }

// No resource: per R-004 this clears only for a portfolio-wide property.write
// grant. Entity- and property-scoped managers do not create new entities -
// createLegalEntity re-checks the same thing server-side regardless.
export default async function NewLegalEntityPage() {
  await requirePermission('property.write')

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        New legal entity
      </h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        The LLC, trust or other entity that owns one or more properties.
        Reports and exports split by entity (PROP-04).
      </p>
      <EntityForm action={createLegalEntity} submitLabel="Create entity" />
    </div>
  )
}
