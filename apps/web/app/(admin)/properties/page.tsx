import Link from 'next/link'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { currentScope as switcherScope } from '@/lib/scope/current-scope.ts'
import { canCreateAnyProperty, listProperties } from '@/lib/properties/queries.ts'

export const metadata = { title: 'Properties — Rental Operations' }

// PROP-01/PROP-04. Guards itself with requireScope() rather than a bare
// requirePermission('property.read') - a resource-less permission check only
// ever passes for a portfolio-wide grant (see requireScope's own comment),
// which would wrongly deny an entity- or property-scoped manager a list that
// is supposed to show them their own properties. Lists exactly what the
// property switcher's resolved scope says the actor may see - the switcher
// selection actually narrows this list, which is the point of building it in
// R-007.
export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{ entityCreated?: string }>
}) {
  const { actor } = await requireScope('property.read')
  const [scope, { entityCreated }, canCreateEntity] = await Promise.all([
    switcherScope(actor),
    searchParams,
    // Bare permission check: per R-004 this only clears for a portfolio-wide
    // grant, which is exactly who may create a NEW entity.
    actorCan('property.write'),
  ])
  // NOT the same check as above: an entity-scoped manager cannot create an
  // entity but genuinely can create a property under their own entity - see
  // canCreateAnyProperty's own comment for why a bare check would hide that.
  const canCreateProperty = canCreateAnyProperty(actor)
  const properties = await listProperties(scope)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Properties</h1>
          <p className="text-muted-foreground text-sm">
            {properties.length} propert{properties.length === 1 ? 'y' : 'ies'}{' '}
            in {scope.selection.kind === 'all' ? 'your scope' : 'this view'}.
          </p>
        </div>
        {(canCreateEntity || canCreateProperty) && (
          <div className="flex gap-2">
            {canCreateEntity && (
              <Link
                href="/properties/entities/new"
                className="border-input hover:bg-accent focus-visible:ring-ring flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                New entity
              </Link>
            )}
            {canCreateProperty && (
              <Link
                href="/properties/new"
                className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                New property
              </Link>
            )}
          </div>
        )}
      </header>

      {entityCreated && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
        >
          Created entity &ldquo;{entityCreated}&rdquo;.
        </p>
      )}

      {properties.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {canCreateProperty
            ? 'No properties yet. Create a legal entity first if you have not, then add a property to it.'
            : 'No properties in your scope yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {properties.map((property) => (
            <li key={property.id}>
              <Link
                href={`/properties/${property.id}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-11 flex-col gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="font-medium">{property.name}</span>
                <span className="text-muted-foreground text-sm">
                  {property.addressLine1}, {property.city}, {property.state}{' '}
                  {property.postalCode} · {property.legalEntity.name}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
