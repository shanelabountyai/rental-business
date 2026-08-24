import { CAUSE_OF_LOSS_LABELS, CLAIM_OUTCOME_LABELS } from '@rental/core/insurance'
import Link from 'next/link'
import { requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { listClaims } from '@/lib/insurance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Claims — Rental Operations' }

// The register (RISK-07, R-089).
//
// Sorted by whether anybody has started mitigating, ahead of everything else.
// A violation case that stalls is a nuisance; a water loss nobody has started
// drying is losing value by the hour and changes what the carrier will argue,
// so it is the one row that has to be at the top of the list.

export default async function ClaimsPage() {
  // R-103: `requireScope`, never a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant, so the obvious
  // guard locks out every entity- and property-scoped actor. See
  // `requireScope`'s own comment.
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const claims = await listClaims(scope)

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Claims</h1>
        <p className="text-muted-foreground text-sm">
          Insurance claims across the portfolio. A claim is opened from the property it happened at,
          against a policy already on file.
        </p>
      </header>

      {claims.length === 0 ? (
        <p className="text-muted-foreground text-sm">No claims.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {claims.map((claim) => (
            <li key={claim.id} className="rounded-md border p-4">
              <Link href={`/claims/${claim.id}`} className="font-medium underline underline-offset-2">
                {CAUSE_OF_LOSS_LABELS[claim.cause].split(' — ')[0]} at {claim.propertyName}
              </Link>
              <p className="text-muted-foreground mt-1 text-sm">
                Loss on {claim.incidentAt.toISOString().slice(0, 10)} ·{' '}
                {claim.claimNumber ? `claim ${claim.claimNumber}` : 'no claim number yet'} ·{' '}
                {claim.status === 'OPEN' ? 'open' : CLAIM_OUTCOME_LABELS[claim.outcome!]}
                {claim.paidCents > 0 && ` · $${(claim.paidCents / 100).toLocaleString('en-US')} received`}
              </p>
              {claim.mitigationUrgent && (
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  Nothing recorded as mitigated on a water loss. Every hour of this is argued about
                  later.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
