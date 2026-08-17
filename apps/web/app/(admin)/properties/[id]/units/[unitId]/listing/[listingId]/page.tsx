import { listingDisclosures } from '@rental/core/listings'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@rental/db'
import { ListingForm } from '@/components/listings/listing-form.tsx'
import { ListingPublishControls } from '@/components/listings/listing-publish-controls.tsx'
import { ListingSyndicationSection } from '@/components/listings/listing-syndication.tsx'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { publishListing, unpublishListing, updateListing } from '@/lib/listings/actions.ts'
import { leadCountsForListing, listingSyndications } from '@/lib/listings/queries.ts'
import { syndicateListing } from '@/lib/listings/syndication.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

export const metadata = { title: 'Listing — Rental Operations' }

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ id: string; unitId: string; listingId: string }>
}) {
  const { id: propertyId, unitId, listingId } = await params

  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { property: true, unit: true },
  })
  if (!listing || listing.propertyId !== propertyId || listing.unitId !== unitId) notFound()

  await requirePermission('unit.write', propertyResource(listing.property))

  const [rule, syndications, leadCounts] = await Promise.all([
    rulesFor(
      { state: listing.property.state, county: listing.property.county },
      new Date(),
    ).catch(() => null),
    listingSyndications(listing.id),
    leadCountsForListing(listing.id),
  ])
  const disclosures = rule
    ? listingDisclosures({
        state: rule.state,
        depositMaxBps: rule.depositMaxBps,
        applicationFeeCapCents: rule.applicationFeeCapCents,
        sourceOfIncomeProtected: rule.sourceOfIncomeProtected,
      })
    : null

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Listing for {listing.unit.name}</h1>
        <p className="text-muted-foreground text-sm">
          {listing.status === 'PUBLISHED' ? (
            <>
              Live at{' '}
              <Link href={`/listings/${listing.id}`} className="underline underline-offset-4">
                /listings/{listing.id}
              </Link>
            </>
          ) : listing.status === 'DRAFT' ? (
            'Draft — not public yet.'
          ) : (
            'Unpublished — no longer public.'
          )}
        </p>
      </header>

      <ListingPublishControls
        status={listing.status}
        publish={publishListing.bind(null, listing.id)}
        unpublish={unpublishListing.bind(null, listing.id)}
      />

      <ListingSyndicationSection
        action={syndicateListing.bind(null, listing.id)}
        canSyndicate={listing.status === 'PUBLISHED'}
        rows={syndications}
      />

      {leadCounts.length > 0 && (
        <section aria-labelledby="leads" className="flex flex-col gap-2 rounded-md border p-4">
          <h2 id="leads" className="text-sm font-semibold">
            Visits by source
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {leadCounts.map((row) => (
              <li key={row.source} className="flex items-center justify-between">
                <span>{row.source}</span>
                <span className="text-muted-foreground">{row.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ListingForm
        action={updateListing.bind(null, listing.id)}
        submitLabel="Save changes"
        defaults={{
          headline: listing.headline ?? undefined,
          description: listing.description ?? undefined,
          rentDollars: listing.rentCents / 100,
          depositDollars: listing.depositCents != null ? listing.depositCents / 100 : '',
          availableOn: listing.availableOn.toISOString().slice(0, 10),
          requirements: listing.requirements ?? undefined,
          petsAllowed: listing.petsAllowed,
          petPolicyText: listing.petPolicyText ?? undefined,
        }}
      />

      <section aria-labelledby="disclosures" className="flex flex-col gap-2 rounded-md border p-4">
        <h2 id="disclosures" className="text-sm font-semibold">
          What the public page will disclose
        </h2>
        {disclosures ? (
          <dl className="flex flex-col gap-2 text-sm">
            {disclosures.map((d) => (
              <div key={d.label}>
                <dt className="font-medium">{d.label}</dt>
                <dd className="text-muted-foreground">{d.text}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">
            No jurisdiction rule is configured for {listing.property.state} - disclosures cannot
            be computed until one is added at /jurisdiction.
          </p>
        )}
      </section>
    </div>
  )
}
