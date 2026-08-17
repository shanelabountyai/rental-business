import { notFound } from 'next/navigation'
import { prisma } from '@rental/db'
import { ListingForm } from '@/components/listings/listing-form.tsx'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { createListing } from '@/lib/listings/actions.ts'

export const metadata = { title: 'New listing — Rental Operations' }

export default async function NewListingPage({
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
      <h1 className="text-2xl font-semibold tracking-tight">New listing for {unit.name}</h1>
      <ListingForm
        action={createListing.bind(null, unitId)}
        submitLabel="Create listing"
        defaults={{
          // Market rent is a starting point, not the asking price - staff
          // can always type over it before the first save.
          rentDollars: unit.marketRentCents != null ? unit.marketRentCents / 100 : '',
        }}
      />
    </div>
  )
}
