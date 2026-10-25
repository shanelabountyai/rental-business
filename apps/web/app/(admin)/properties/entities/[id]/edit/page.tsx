import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { PageHeader } from '@/components/page-header.tsx'
import { EntityForm } from '@/components/properties/entity-form.tsx'
import { requirePermission, requireStaff } from '@/lib/auth/guard.ts'
import { updateLegalEntity } from '@/lib/properties/actions.ts'

export const metadata = { title: 'Edit legal entity — Rental Operations' }

export default async function EditLegalEntityPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // ORG-05: signed in before the lookup, so a stranger cannot tell an id that exists from one that does not.
  await requireStaff()
  // Scoped to THIS entity, so an entity-scoped manager may edit their own
  // entity but not someone else's (ROLE-01).
  // R-285b: read first so the check carries the entity's org - a
  // portfolio-wide owner elsewhere is out of scope here.
  const entity = await prisma.legalEntity.findUnique({ where: { id } })
  await requirePermission('property.write', { orgId: entity?.orgId, legalEntityId: id })
  if (!entity) notFound()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={<>Edit {entity.name}</>} />
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
