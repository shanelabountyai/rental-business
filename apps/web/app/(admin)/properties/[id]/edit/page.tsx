import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { PropertyForm } from '@/components/properties/property-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { updateProperty } from '@/lib/properties/actions.ts'

export const metadata = { title: 'Edit property — Rental Operations' }

export default async function EditPropertyPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // Scoped to THIS property, so a property-scoped manager may edit their own
  // property but nothing outside it (ROLE-01).
  await requirePermission('property.write', { propertyId: id })

  const property = await prisma.property.findUnique({
    where: { id },
    include: { legalEntity: { select: { id: true, name: true } } },
  })
  if (!property) notFound()

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
        }}
      />
    </div>
  )
}
