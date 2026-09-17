import { notFound } from 'next/navigation'
import { addBusinessDays, utcToBusinessDate } from '@rental/core/scheduling'
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

  const [property, unit, underNotice] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId } }),
    prisma.unit.findUnique({ where: { id: unitId } }),
    // The outgoing tenancy, when the listing is being prepared during its
    // notice period (R-219) - its rent and move-out date are the best
    // starting points this page has.
    prisma.lease.findFirst({
      where: { unitId, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] }, noticeEffectiveOn: { not: null } },
      select: { rentCents: true, noticeEffectiveOn: true },
    }),
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
          rentDollars:
            unit.marketRentCents != null
              ? unit.marketRentCents / 100
              : underNotice
                ? underNotice.rentCents / 100
                : '',
          // The day after move-out: a floor, not a promise - staff move it
          // out by however long the turn will take.
          availableOn: underNotice
            ? addBusinessDays(utcToBusinessDate(underNotice.noticeEffectiveOn!), 1)
            : undefined,
        }}
      />
    </div>
  )
}
