import Link from 'next/link'
import { notFound } from 'next/navigation'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { currentScope as switcherScope } from '@/lib/scope/current-scope.ts'
import { getUnitDetail } from '@/lib/units/queries.ts'

export const metadata = { title: 'Unit — Rental Operations' }

const STATUS_LABELS: Record<string, string> = {
  OCCUPIED: 'Occupied',
  VACANT: 'Vacant',
  MAKE_READY: 'Make-ready',
  DOWN: 'Down',
}

/// Same convention as the property detail page: a section this item does not
/// fill in names the item that will, so a half-built product explains itself.
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

export default async function UnitDetailPage({
  params,
}: {
  params: Promise<{ id: string; unitId: string }>
}) {
  const { id: propertyId, unitId } = await params
  const { actor } = await requireScope('unit.read')
  const scope = await switcherScope(actor)

  const unit = await getUnitDetail(propertyId, unitId, scope)
  if (!unit) notFound()

  const canWrite = await actorCan('unit.write', propertyResource(unit.property))

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-sm">
            <Link
              href={`/properties/${propertyId}`}
              className="underline underline-offset-4"
            >
              {unit.property.name}
            </Link>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{unit.name}</h1>
        </div>
        {canWrite && (
          <Link
            href={`/properties/${propertyId}/units/${unit.id}/edit`}
            className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Edit
          </Link>
        )}
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-1 sm:col-span-2">
          {STATUS_LABELS[unit.status] ?? unit.status}
        </dd>
        {unit.marketRentCents != null && (
          <>
            <dt className="text-muted-foreground">Market rent</dt>
            <dd className="col-span-1 sm:col-span-2">
              ${(unit.marketRentCents / 100).toLocaleString()}/mo
            </dd>
          </>
        )}
        {(unit.bedrooms != null || unit.bathrooms != null) && (
          <>
            <dt className="text-muted-foreground">Beds / baths</dt>
            <dd className="col-span-1 sm:col-span-2">
              {unit.bedrooms ?? '—'} bed{unit.bedrooms === 1 ? '' : 's'} /{' '}
              {unit.bathrooms != null ? String(unit.bathrooms) : '—'} bath
              {unit.bathrooms?.toString() === '1' ? '' : 's'}
            </dd>
          </>
        )}
        {unit.squareFeet != null && (
          <>
            <dt className="text-muted-foreground">Square feet</dt>
            <dd className="col-span-1 sm:col-span-2">{unit.squareFeet}</dd>
          </>
        )}
        {unit.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="col-span-1 sm:col-span-2">{unit.notes}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-3">
        <EmptySection
          title="Operational data"
          ownedBy="R-014"
          description="Lock and lockbox codes, appliance details, filter sizes, utility accounts, shutoff locations."
        />
        <EmptySection
          title="Lease"
          ownedBy="R-033"
          description="The current and past tenancies at this unit."
        />
        <EmptySection
          title="Maintenance"
          ownedBy="R-022"
          description="Tickets and work orders for this unit."
        />
      </div>
    </div>
  )
}
