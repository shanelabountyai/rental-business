import Link from 'next/link'
import { notFound } from 'next/navigation'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { currentScope as switcherScope } from '@/lib/scope/current-scope.ts'
import { getPropertyDetail } from '@/lib/properties/queries.ts'

export const metadata = { title: 'Property — Rental Operations' }

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  SINGLE_FAMILY: 'Single-family',
  DUPLEX: 'Duplex',
  TRIPLEX: 'Triplex',
  FOURPLEX: 'Fourplex',
  TOWNHOUSE: 'Townhouse',
  CONDO: 'Condo',
  MANUFACTURED: 'Manufactured',
}

/// PROP-01: "Given a created property, when I view it, then I see sections
/// for units, leases, tickets, documents, and financials (empty states OK)."
/// Each names the item that fills it in, same convention as the shell's
/// section placeholders - a half-built product should explain itself.
function EmptySection({
  title,
  ownedBy,
  description,
}: {
  title: string
  ownedBy: string
  description: string
}) {
  return (
    <section className="flex flex-col gap-1 rounded-md border p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
      <p className="text-muted-foreground text-xs">
        Built by <code className="font-mono">{ownedBy}</code>.
      </p>
    </section>
  )
}

export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // requireScope, not a bare requirePermission('property.read') - see that
  // function's comment. A property-scoped manager holds property.read only
  // over their own property, and a resource-less check would deny them this
  // page entirely rather than letting getPropertyDetail's scoped lookup
  // decide per-property.
  const { actor } = await requireScope('property.read')
  const scope = await switcherScope(actor)

  const property = await getPropertyDetail(id, scope)
  if (!property) notFound()

  const canWrite = await actorCan('property.write', { propertyId: id })

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {property.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {property.addressLine1}
            {property.addressLine2 ? `, ${property.addressLine2}` : ''},{' '}
            {property.city}, {property.state} {property.postalCode}
          </p>
        </div>
        {canWrite && (
          <Link
            href={`/properties/${property.id}/edit`}
            className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Edit
          </Link>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Entity</dt>
        <dd className="col-span-1 sm:col-span-2">
          {property.legalEntity.name}
        </dd>
        <dt className="text-muted-foreground">Type</dt>
        <dd className="col-span-1 sm:col-span-2">
          {PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType}
        </dd>
        <dt className="text-muted-foreground">Timezone</dt>
        <dd className="col-span-1 sm:col-span-2">{property.timezone}</dd>
        {(property.bedrooms != null || property.bathrooms != null) && (
          <>
            <dt className="text-muted-foreground">Beds / baths</dt>
            <dd className="col-span-1 sm:col-span-2">
              {property.bedrooms ?? '—'} bed
              {property.bedrooms === 1 ? '' : 's'} /{' '}
              {property.bathrooms != null ? String(property.bathrooms) : '—'}{' '}
              bath{property.bathrooms?.toString() === '1' ? '' : 's'}
            </dd>
          </>
        )}
        {property.yearBuilt != null && (
          <>
            <dt className="text-muted-foreground">Year built</dt>
            <dd className="col-span-1 sm:col-span-2">{property.yearBuilt}</dd>
          </>
        )}
        {property.acquiredOn != null && (
          <>
            <dt className="text-muted-foreground">Acquired</dt>
            <dd className="col-span-1 sm:col-span-2">
              {property.acquiredOn.toISOString().slice(0, 10)}
            </dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-3">
        <EmptySection
          title="Units"
          ownedBy="R-009"
          description="Main house, ADU, duplex side - each with its own status, market rent and attributes."
        />
        <EmptySection
          title="Leases"
          ownedBy="R-016"
          description="Tenancies at this property, current and past."
        />
        <EmptySection
          title="Maintenance"
          ownedBy="R-022"
          description="Tickets and work orders for this property."
        />
        <EmptySection
          title="Documents"
          ownedBy="R-012"
          description="Deed, insurance, warranties and the versioned photo library."
        />
        <EmptySection
          title="Financials"
          ownedBy="R-035"
          description="Rent roll and ledger for this property. Nothing posted yet."
        />
      </div>
    </div>
  )
}
