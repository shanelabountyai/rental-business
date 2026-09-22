import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import { listCriteriaVersions } from '@/lib/screening/criteria-queries.ts'

export const metadata = { title: 'Screening criteria — Rental Operations' }

// R-242 (OQ-6): a screen to see and version ScreeningCriteria, which had
// none - the seeded v1 placeholder (07-decisions.md OQ-6) could be read only
// by a script or a database client, and nothing let an owner record that an
// attorney had reviewed it. Portfolio-wide, like /jurisdiction - criteria
// apply to every applicant across the whole portfolio at once
// (ScreeningCriteria's own schema comment), so there is no scoped list to
// build here.
export default async function ScreeningCriteriaPage({
  searchParams,
}: {
  searchParams: Promise<{ versioned?: string }>
}) {
  await requirePermission('screening.criteria.read')
  const [versions, canWrite, { versioned }] = await Promise.all([
    listCriteriaVersions(),
    actorCan('screening.criteria.write'),
    searchParams,
  ])
  const current = versions.find((v) => v.effectiveTo == null)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Screening criteria
          </h1>
          <p className="text-muted-foreground max-w-prose text-sm">
            The versioned income, credit and lookback criteria applied to
            every applicant (LEASE-04). No AI or algorithmic scoring, ever -
            this is where the numbers a person compares a report against are
            recorded, with who reviewed them.
          </p>
        </div>
        {canWrite && (
          <Link
            href="/screening-criteria/new"
            className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            New version
          </Link>
        )}
      </header>

      {versioned && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Added a new criteria version.
        </p>
      )}

      {current && !current.reviewedBy && (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          The current criteria (v{current.version}) have never been reviewed
          by an attorney (OQ-6). This is a release gate, not a formality -
          add a reviewed version before screening a real applicant against
          it.
        </p>
      )}

      {versions.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No criteria configured. Screening cannot run with nothing to
          evaluate against.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 pt-1 text-sm">
          {versions.map((version) => (
            <li key={version.id}>
              v{version.version} · effective{' '}
              {friendlyBusinessDate(utcToBusinessDate(version.effectiveFrom))}
              {version.effectiveTo
                ? ` to ${friendlyBusinessDate(utcToBusinessDate(version.effectiveTo))}`
                : ' — current'}
              {' · '}
              {(version.incomeToRentMultiplierX100 / 100).toFixed(1)}x income
              {version.minCreditScore != null
                ? `, ${version.minCreditScore} credit floor`
                : ', no credit floor'}
              {`, ${version.evictionLookbackMonths}mo eviction / ${version.criminalLookbackMonths}mo criminal lookback`}
              <span className="text-muted-foreground">
                {version.reviewedBy
                  ? ` · reviewed by ${version.reviewedBy}`
                  : ' · unreviewed'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
