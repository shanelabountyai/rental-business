import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { PropertyForm } from '@/components/properties/property-form.tsx'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { updateProperty } from '@/lib/properties/actions.ts'

export const metadata = { title: 'Edit property — Rental Operations' }

export default async function EditPropertyPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // Fetched before the guard, not after: the guard needs the property's
  // legalEntityId to correctly match an entity-scoped grant (propertyResource
  // - see its own comment for the bug this fixes), so the row has to be in
  // hand first.
  const property = await prisma.property.findUnique({
    where: { id },
    include: { legalEntity: { select: { id: true, name: true } } },
  })
  if (!property) notFound()

  // Both ids, so a property-scoped OR an entity-scoped grant can match
  // (ROLE-01).
  await requirePermission('property.write', propertyResource(property))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Edit {property.name}
      </h1>
      <PropertyForm
        action={updateProperty.bind(null, id)}
        submitLabel="Save changes"
        lockEntity={property.legalEntity}
        defaults={{
          name: property.name,
          propertyType: property.propertyType,
          timezone: property.timezone,
          addressLine1: property.addressLine1,
          addressLine2: property.addressLine2 ?? undefined,
          city: property.city,
          state: property.state,
          postalCode: property.postalCode,
          bedrooms: property.bedrooms ?? '',
          bathrooms: property.bathrooms != null ? Number(property.bathrooms) : '',
          yearBuilt: property.yearBuilt ?? '',
          acquiredOn: property.acquiredOn
            ? property.acquiredOn.toISOString().slice(0, 10)
            : undefined,
          historyStartsOn: property.historyStartsOn
            ? property.historyStartsOn.toISOString().slice(0, 10)
            : undefined,
          metro: property.metro ?? undefined,
          tags: property.tags.join(', '),
          hasPool: property.hasPool,
          hasWellOrSeptic: property.hasWellOrSeptic,
          moldHistoryNotes: property.moldHistoryNotes ?? undefined,
          bedbugHistoryNotes: property.bedbugHistoryNotes ?? undefined,
        }}
      />
    </div>
  )
}
