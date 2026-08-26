import { listingDisclosures } from '@rental/core/listings'
import { formatCents } from '@rental/core/money'
import { notFound } from 'next/navigation'
import { ListingInquiryForm } from '@/components/listings/listing-inquiry-form.tsx'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { recordListingLead } from '@/lib/listings/leads.ts'
import { publicListing, unitPhotosForListing } from '@/lib/listings/queries.ts'
import { submitInquiry } from '@/lib/prospects/actions.ts'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const listing = await publicListing(id)
  if (!listing) return { title: 'Listing not found' }
  return {
    title: listing.headline || `${listing.property.addressLine1}, ${listing.property.city}`,
    // Discoverable on purpose - the opposite call from the token-gated pages
    // next door (vendor/verify/pay), whose metadata explicitly refuses
    // indexing because the URL itself is a credential. A published listing
    // has no secret in it; being findable IS the point.
  }
}

// The hosted listing page (LEASE-01, R-056).
//
// PUBLIC BY DESIGN, and a new kind of public route for this product - see
// route-guards.test.ts's PUBLIC_ROUTES for the reasoning recorded there.
// Every other zero-login page in apps/web/app (vendor/[token], verify/
// [token], pay/[token]) is public because a SECRET in the path is the
// credential; this one is public because the RECORD ITSELF is meant to be
// public once published, and PUBLISHED is the entire authorization -
// publicListing() enforces it, not this page.
//
// A DRAFT or UNPUBLISHED listing 404s exactly like a record outside an
// actor's scope does everywhere else in this product (ROLE-01) - "not
// public" and "does not exist" must read the same to an anonymous visitor,
// or the response itself would confirm a draft's id is real.
export default async function PublicListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ src?: string }>
}) {
  const { id } = await params
  const { src } = await searchParams
  const listing = await publicListing(id)
  if (!listing) notFound()

  // Fire-and-forget - see recordListingLead's own comment for why a lead
  // write failing must never be why a prospect cannot see the listing.
  void recordListingLead(id, src)

  const [photos, rule] = await Promise.all([
    unitPhotosForListing(listing.unitId),
    rulesFor(
      { state: listing.property.state, county: listing.property.county },
      new Date(),
    ).catch(() => null),
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
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {listing.headline || `${listing.property.addressLine1}, ${listing.property.city}`}
        </h1>
        <p className="text-muted-foreground text-sm">
          {listing.property.addressLine1}, {listing.property.city}, {listing.property.state}{' '}
          {listing.property.postalCode}
        </p>
      </header>

      {/* NOT `alt=""` (1.1.1, R-114). These are the primary content of a
          rental listing, and marking them decorative left a blind prospect
          with rent, beds and disclosures and no acknowledgement that a gallery
          exists at all - so "are there photos of this place?" had no answer on
          the page. `Document` has no caption column, so this is the honest
          interim: it says what the picture is OF and how many there are, which
          is what tells somebody whether to ask for a description. A real
          caption written by whoever uploads the photo is the proper fix and
          belongs with the uploader, not here. */}
      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((photo, index) => (
            <img
              key={photo.id}
              src={`/listings/${listing.id}/photos/${photo.id}`}
              alt={`Photo ${index + 1} of ${photos.length} of ${listing.property.addressLine1}`}
              className="aspect-square w-full rounded-md object-cover"
            />
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Rent</dt>
        <dd>{formatCents(listing.rentCents)}/mo</dd>
        {listing.depositCents != null && (
          <>
            <dt className="text-muted-foreground">Deposit</dt>
            <dd>{formatCents(listing.depositCents)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Available</dt>
        {/* Date-only column, read as the plain calendar string - going
            through a timezone converter here is the exact bug CLAUDE.md
            documents for @db.Date fields (utcToBusinessDate/toISOString
            only, never friendlyDate/businessDate). */}
        <dd>{listing.availableOn.toISOString().slice(0, 10)}</dd>
        {(listing.unit.bedrooms != null || listing.unit.bathrooms != null) && (
          <>
            <dt className="text-muted-foreground">Beds / baths</dt>
            <dd>
              {listing.unit.bedrooms ?? '—'} bed{listing.unit.bedrooms === 1 ? '' : 's'} /{' '}
              {listing.unit.bathrooms != null ? String(listing.unit.bathrooms) : '—'} bath
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Pets</dt>
        <dd>{listing.petsAllowed ? (listing.petPolicyText ?? 'Allowed') : 'Not allowed'}</dd>
      </dl>

      {listing.description && (
        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Description</h2>
          <p className="text-sm whitespace-pre-wrap">{listing.description}</p>
        </section>
      )}

      {listing.requirements && (
        <section className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Requirements</h2>
          <p className="text-sm whitespace-pre-wrap">{listing.requirements}</p>
        </section>
      )}

      <section aria-labelledby="disclosures" className="flex flex-col gap-2 border-t pt-4">
        <h2 id="disclosures" className="text-sm font-semibold">
          Disclosures
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
            No jurisdiction disclosures are on file for {listing.property.state}.
          </p>
        )}
      </section>

      <section aria-labelledby="inquire" className="flex flex-col gap-3 border-t pt-4">
        <h2 id="inquire" className="text-lg font-semibold">
          Ask about this listing
        </h2>
        <p className="text-muted-foreground text-sm">
          We&rsquo;ll send a few quick pre-screening questions - the same ones everyone who inquires
          gets asked.
        </p>
        <ListingInquiryForm action={submitInquiry.bind(null, listing.id)} source={src ?? 'direct'} />
      </section>
    </main>
  )
}
