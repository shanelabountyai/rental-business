import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Search — Rental Operations' }

// The universal search stub the shell's header posts to.
//
// A stub with a real route rather than a disabled input: the header control is
// the thing being built here, and a control that goes nowhere teaches staff it
// does not work. This page states plainly that the index does not exist yet.
//
// Whichever item builds the index must scope every result through R-004 -
// search is the classic place a property-scoped manager sees a lease from a
// property they have no access to, because the result set was assembled before
// anyone thought about scope.
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('property.read')
  const [{ q }, scope] = await Promise.all([searchParams, currentScope(actor)])
  const query = q?.trim()

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
      {query ? (
        <p className="text-muted-foreground text-sm">
          Nothing is indexed yet, so there are no results for{' '}
          <strong className="text-foreground">{query}</strong>.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          Type in the search box above to look across properties, leases,
          tenants and work orders.
        </p>
      )}
      <p className="text-muted-foreground text-sm">
        Searching {scope.propertyIds.length} propert
        {scope.propertyIds.length === 1 ? 'y' : 'ies'} in your scope. Results
        will never cross that boundary.
      </p>
    </div>
  )
}
