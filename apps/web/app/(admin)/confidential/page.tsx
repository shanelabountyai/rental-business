import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { listConfidentialCases } from '@/lib/confidential/queries.ts'

export const metadata = {
  title: 'Confidential — Rental Operations',
  // Never indexed, and the title says nothing beyond "restricted". A browser
  // tab and a history entry are both read by whoever is standing behind the
  // person using the laptop.
  robots: { index: false, follow: false },
}

// The register of confidential safety cases (RISK-04, ROLE-05; R-091).
//
// BEHIND `confidential.read`, which is seeded to the owner role alone. A
// manager reaching this URL is redirected to /no-access, which names the
// missing permission and nothing else - the same answer for every id and for
// no id, so it confirms nothing about what is here.
//
// NOTHING ON THIS PAGE SAYS WHAT THESE CASES ARE ABOUT, because the page
// itself is read over somebody's shoulder. The address and the summary are
// the content, and the summary is one click further in.
//
// NO `loading.tsx` HERE OR BELOW - R-099's rule. The detail page answers 404
// for a case outside scope, deliberately (ROLE-01), and a Suspense boundary
// above it would stream a 200 header before the page ran and turn that 404
// into a 200 that only LOOKS right.

export default async function ConfidentialPage() {
  // `requireScope`, NOT a resource-less `requirePermission` - see that
  // function's own comment. An empty resource only ever matches a
  // portfolio-wide grant, so the obvious guard sends an entity-scoped owner
  // to /no-access on their own register. That bug shipped dormant once
  // already (R-007's section placeholders) and it landed here too; the e2e
  // scoping test is what found it.
  const { actor } = await requireScope('confidential.read')
  const scope = await currentScope(actor)
  const cases = await listConfidentialCases(scope)

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Confidential</h1>
        <p className="text-muted-foreground text-sm">
          Restricted safety cases. Visible only to staff holding the confidential
          permission, which is the Owner role by default. A case is opened from the
          tenancy it concerns.
        </p>
      </header>

      {cases.length === 0 ? (
        <p className="text-muted-foreground text-sm">No cases.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cases.map((row) => (
            <li key={row.id} className="rounded-md border p-4">
              <Link
                href={`/confidential/${row.id}`}
                className="font-medium underline underline-offset-2"
              >
                {row.lease.property.name} — {row.lease.unit.name}
              </Link>
              <p className="text-muted-foreground text-sm">
                {row.status === 'OPEN' ? 'Open' : 'Closed'} · opened{' '}
                {friendlyDate(row.openedAt, row.lease.property.timezone)} by{' '}
                {row.openedBy.name}
                {row.lockChangeWorkOrderId ? ' · re-key ordered' : ' · no re-key ordered'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
