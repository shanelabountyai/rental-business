import Link from 'next/link'
import { OpenCaseForm } from '@/components/evictions/open-case-form.tsx'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { openEvictionCase } from '@/lib/evictions/actions.ts'
import { leasesWithoutOpenCase } from '@/lib/evictions/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Open an eviction case — Rental Operations' }

export default async function NewEvictionCasePage() {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('eviction.manage')
  const scope = await currentScope(actor)
  const leases = await leasesWithoutOpenCase(scope)

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Link
        href="/evictions"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        ← Evictions
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Open an eviction case</h1>
      <p className="text-muted-foreground text-sm">
        Opening a case files nothing with anybody. It starts the record — the notices, their proof of service, the
        costs and the dates — that an attorney would be handed.
      </p>

      {leases.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Every active tenancy in view already has an open case, or there are no active tenancies here.
        </p>
      ) : (
        <OpenCaseForm
          action={openEvictionCase}
          leases={leases.map((lease) => ({
            value: lease.id,
            label: `${lease.property.name} — ${lease.unit.name} · ${
              lease.leaseTenants.map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`).join(', ') ||
              'No tenant recorded'
            }`,
          }))}
        />
      )}
    </div>
  )
}
