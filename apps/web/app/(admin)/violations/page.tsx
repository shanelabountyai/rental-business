import { friendlyBusinessDate, friendlyDate } from '@rental/core/scheduling'
import {
  VIOLATION_KIND_LABELS,
  VIOLATION_OUTCOME_LABELS,
} from '@rental/core/violations'
import Link from 'next/link'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { listViolationCases } from '@/lib/violations/queries.ts'

export const metadata = { title: 'Violations — Rental Operations' }

// The register (RISK-02, RISK-03; R-088).
//
// Open first, oldest first inside that. A violation case's failure mode is
// not being wrong, it is being forgotten: three photographs taken in March
// and nobody back since is how a blocked exit becomes a fire and how "we told
// them repeatedly" becomes indefensible.

export default async function ViolationsPage() {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('lease.read')
  const scope = await currentScope(actor)
  const cases = await listViolationCases(scope)

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Violations</h1>
        <p className="text-muted-foreground text-sm">
          Unauthorized occupants and animals, and conditions that breach a lease
          or safety term. A case is opened from the tenancy it is about.
        </p>
      </header>

      {cases.length === 0 ? (
        <p className="text-muted-foreground text-sm">No cases.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cases.map((row) => (
            <li key={row.id} className="rounded-md border p-4">
              <Link
                href={`/violations/${row.id}`}
                className="font-medium underline underline-offset-2"
              >
                {VIOLATION_KIND_LABELS[row.kind]}
              </Link>
              <p className="text-muted-foreground mt-1 text-sm">
                {row.propertyName} · {row.unitLabel} ·{' '}
                {row.tenantNames.join(', ') || 'no tenant recorded'}
              </p>
              <p className="mt-1 text-sm">
                {row.status === 'OPEN'
                  ? `Open since ${friendlyDate(row.openedAt, 'UTC')}`
                  : VIOLATION_OUTCOME_LABELS[row.outcome!]}
                {' · '}
                {row.observationCount} observation{row.observationCount === 1 ? '' : 's'}
                {row.lastObservedOn
                  ? ` · last seen ${friendlyBusinessDate(row.lastObservedOn)}`
                  : ' · nothing observed yet'}
              </p>
              {row.openAccommodationCount > 0 && (
                <p className="mt-1 text-sm text-amber-800">
                  {row.openAccommodationCount} undecided accommodation request
                  {row.openAccommodationCount === 1 ? '' : 's'} on this tenancy.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
