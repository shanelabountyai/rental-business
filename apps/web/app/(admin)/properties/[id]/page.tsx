import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DocumentsSection } from '@/components/documents/documents-section.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { currentScope as switcherScope } from '@/lib/scope/current-scope.ts'
import { listDeletedDocuments, listDocuments } from '@/lib/documents/queries.ts'
import { getPropertyDetail } from '@/lib/properties/queries.ts'
import { listUnits } from '@/lib/units/queries.ts'

const UNIT_STATUS_LABELS: Record<string, string> = {
  OCCUPIED: 'Occupied',
  VACANT: 'Vacant',
  MAKE_READY: 'Make-ready',
  DOWN: 'Down',
}

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

  // Both ids (propertyResource), not just propertyId - an entity-scoped
  // manager's Edit button was wrongly hidden here until this fix, the same
  // gap as the edit page's own guard.
  const canWrite = await actorCan('property.write', propertyResource(property))
  const [units, canWriteUnits, documents, deletedDocuments, canWriteDocuments, canDeleteDocuments] =
    await Promise.all([
      listUnits(id, scope),
      actorCan('unit.write', propertyResource(property)),
      listDocuments(id, scope),
      listDeletedDocuments(id, scope),
      actorCan('document.write', propertyResource(property)),
      actorCan('document.delete', propertyResource(property)),
    ])

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
        <section className="flex flex-col gap-3 rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Units</h2>
            {canWriteUnits && (
              <Link
                href={`/properties/${property.id}/units/new`}
                className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                Add unit
              </Link>
            )}
          </div>
          {units.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No units yet. Most single-family properties are one unit; add an
              ADU or a duplex side here too.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {units.map((unit) => (
                <li key={unit.id}>
                  <Link
                    href={`/properties/${property.id}/units/${unit.id}`}
                    className="hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center justify-between gap-2 rounded-md px-2 py-2 text-sm focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                  >
                    <span className="font-medium">{unit.name}</span>
                    <span className="text-muted-foreground">
                      {UNIT_STATUS_LABELS[unit.status] ?? unit.status}
                      {unit.marketRentCents != null &&
                        ` · $${(unit.marketRentCents / 100).toLocaleString()}/mo`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
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
        <DocumentsSection
          propertyId={id}
          documents={documents}
          deletedDocuments={deletedDocuments}
          canWrite={canWriteDocuments}
          canDelete={canDeleteDocuments}
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
