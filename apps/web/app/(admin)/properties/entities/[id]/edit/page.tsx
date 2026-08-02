import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { EntityForm } from '@/components/properties/entity-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { updateLegalEntity } from '@/lib/properties/actions.ts'

export const metadata = { title: 'Edit legal entity — Rental Operations' }

export default async function EditLegalEntityPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // Scoped to THIS entity, so an entity-scoped manager may edit their own
  // entity but not someone else's (ROLE-01).
  await requirePermission('property.write', { legalEntityId: id })

  const entity = await prisma.legalEntity.findUnique({ where: { id } })
  if (!entity) notFound()

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Edit {entity.name}
      </h1>
      <EntityForm
        action={updateLegalEntity.bind(null, id)}
        submitLabel="Save changes"
        defaults={{
          name: entity.name,
          type: entity.type,
          formationState: entity.formationState ?? undefined,
        }}
      />
    </div>
  )
}
