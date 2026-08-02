import Link from 'next/link'
import { PropertyForm } from '@/components/properties/property-form.tsx'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { createProperty } from '@/lib/properties/actions.ts'
import { listWritableLegalEntities } from '@/lib/properties/queries.ts'

export const metadata = { title: 'New property — Rental Operations' }

export default async function NewPropertyPage() {
  // requireScope, not a bare requirePermission('property.write') - see that
  // function's comment. This only proves the actor holds property.write over
  // SOMETHING; a narrower "but only over a specific property, not an entity"
  // case is handled below as an in-page explanation rather than a denial,
  // because it is not really a denial.
  const { actor } = await requireScope('property.write')
  const legalEntities = await listWritableLegalEntities(actor)

  if (legalEntities.length === 0) {
    const canCreateEntity = await actorCan('property.write')
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">New property</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          You don&rsquo;t have create access to any legal entity yet. Ask
          whoever manages access to grant you entity-level access
          {canCreateEntity ? ', or create one yourself.' : '.'}
        </p>
        {canCreateEntity && (
          <Link
            href="/properties/entities/new"
            className="text-sm underline underline-offset-4"
          >
            Create a legal entity
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New property</h1>
      <PropertyForm
        action={createProperty}
        submitLabel="Create property"
        defaults={{}}
        legalEntities={legalEntities}
      />
    </div>
  )
}
