import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { UnitForm } from '@/components/units/unit-form.tsx'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { updateUnit } from '@/lib/units/actions.ts'

export const metadata = { title: 'Edit unit — Rental Operations' }

export default async function EditUnitPage({
  params,
}: {
  params: Promise<{ id: string; unitId: string }>
}) {
  const { id: propertyId, unitId } = await params

  const [property, unit] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId } }),
    prisma.unit.findUnique({ where: { id: unitId } }),
  ])
  if (!property || !unit || unit.propertyId !== propertyId) notFound()

  await requirePermission('unit.write', propertyResource(property))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Edit {unit.name}
      </h1>
      <UnitForm
        action={updateUnit.bind(null, propertyId, unitId)}
        submitLabel="Save changes"
        defaults={{
          name: unit.name,
          status: unit.status,
          marketDollars: unit.marketRentCents != null ? unit.marketRentCents / 100 : '',
          bedrooms: unit.bedrooms ?? '',
          bathrooms: unit.bathrooms != null ? Number(unit.bathrooms) : '',
          squareFeet: unit.squareFeet ?? '',
          notes: unit.notes ?? '',
        }}
      />
    </div>
  )
}
