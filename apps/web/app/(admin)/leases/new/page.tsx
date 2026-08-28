import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { LeaseForm } from '@/components/leases/lease-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { createLease } from '@/lib/leases/actions.ts'
import { unitsForNewLease } from '@/lib/leases/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'New lease — Rental Operations' }

// Both paths start here (LEASE-06, RISK-08). The origin radio is the fork:
// an ordinary application, or a tenancy inherited at acquisition. Everything
// that differs about the inherited path follows from that one answer rather
// than from a separate screen, because the terms themselves are entered the
// same way either way - what differs is what is KNOWN about them.

export default async function NewLeasePage() {
  const { actor } = await requireScope('lease.write')
  const scope = await currentScope(actor)
  const units = await unitsForNewLease(scope)

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/leases"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← All leases
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New lease</h1>
        <p className="text-muted-foreground text-sm">
          Created as a draft. Add the people on it, then make it active.
        </p>
      </header>

      {units.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          There are no units in scope to put a lease on.
        </p>
      ) : (
        <LeaseForm
          action={createLease}
          showOrigin
          submitLabel="Create draft lease"
          units={units.map((unit) => ({
            id: unit.id,
            name: unit.name,
            propertyName: unit.property.name,
            status: unit.status,
            marketRentCents: unit.marketRentCents,
            occupiedUntil: unit.leases[0]
              ? (unit.leases[0].endsOn
                  ? friendlyBusinessDate(utcToBusinessDate(unit.leases[0].endsOn))
                  : 'month-to-month')
              : null,
          }))}
        />
      )}
    </div>
  )
}
