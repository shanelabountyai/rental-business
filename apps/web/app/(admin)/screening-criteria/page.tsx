import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import { CRITERION_LABELS, criterionInForce } from '@rental/core/screening'
import { addDecisionReason, retireDecisionReason } from '@/lib/screening/criteria-actions.ts'
import { listCriteriaVersions, listDecisionReasons } from '@/lib/screening/criteria-queries.ts'
import { AddDecisionReasonForm, RetireDecisionReasonForm } from '@/components/screening/decision-reason-forms.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'

export const metadata = { title: 'Screening criteria' }

// R-242 (OQ-6): a screen to see and version ScreeningCriteria, which had
// none - the seeded v1 placeholder (07-decisions.md OQ-6) could be read only
// by a script or a database client, and nothing let an owner record that an
// attorney had reviewed it. Portfolio-wide, like /jurisdiction - criteria
// apply to every applicant across the whole portfolio at once
// (ScreeningCriteria's own schema comment), so there is no scoped list to
// build here.
//
// R-297 (PRD 10 §7.1): the versions and the reason list are the signed-in
// org's own, and every reason names the criterion it rests on.
export default async function ScreeningCriteriaPage({
  searchParams,
}: {
  searchParams: Promise<{ versioned?: string }>
}) {
  const actor = await requirePermission('screening.criteria.read')
  const [versions, reasons, canWrite, { versioned }] = await Promise.all([
    listCriteriaVersions(actor.orgId),
    listDecisionReasons(actor.orgId),
    actorCan('screening.criteria.write'),
    searchParams,
  ])
  const current = versions.find((v) => v.effectiveTo == null)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Screening criteria">
          <p className="text-muted-foreground max-w-prose text-sm">
            The versioned income, credit and lookback criteria applied to
            every applicant (LEASE-04). No AI or algorithmic scoring, ever -
            this is where the numbers a person compares a report against are
            recorded, with who reviewed them.
          </p>
        </PageHeader>
        {canWrite && (
          <div className="flex flex-wrap gap-3">
            <Link
              href="/screening-criteria/report"
              className="flex min-h-11 items-center text-sm underline underline-offset-2"
            >
              Adverse-action report
            </Link>
            <Link
              href="/screening-criteria/new"
              className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 items-center px-4 py-2 text-sm`}
            >
              New version
            </Link>
          </div>
        )}
      </header>

      {versioned && (
        <p
          role="status"
          className="rounded-md border border-success/35 bg-success/6 px-3 py-2 text-sm text-success"
        >
          Added a new criteria version.
        </p>
      )}

      {current && !current.reviewedBy && (
        <p
          role="alert"
          className="rounded-md border border-warning/35 bg-warning/6 px-3 py-2 text-sm text-warning"
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

      {/* R-269, made the org's own and tied to written criteria by R-297. The
          wording still waits on counsel (OQ-16). */}
      <section aria-labelledby="decision-reasons" className="flex flex-col gap-2">
        <h2 id="decision-reasons" className="text-sm font-semibold">
          Decline reasons
        </h2>
        <p className="text-warning max-w-prose text-sm">
          Not reviewed by counsel (OQ-16). A decline or conditional approval
          must pick one, and only a reason resting on a criterion in the
          version the applicant was screened against can be picked. It is
          recorded on the decision and kept out of the adverse-action notice
          until counsel approves this list.
        </p>
        {reasons.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No reasons yet. Nothing can be declined until one is added.
          </p>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm break-words">
            {reasons.map((reason) => (
              <li key={reason.code}>
                {reason.label}
                <span className="text-muted-foreground">
                  {' · '}
                  {reason.criterion
                    ? CRITERION_LABELS[reason.criterion]
                    : 'no written criterion, cannot be picked'}
                  {reason.criterion && current && !criterionInForce(current, reason.criterion)
                    ? ` (not in v${current.version})`
                    : ''}
                  {reason.retiredAt ? ' · retired' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <div className="flex flex-col gap-3 pt-2">
            <AddDecisionReasonForm
              action={addDecisionReason}
              criteria={Object.entries(CRITERION_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <RetireDecisionReasonForm
              action={retireDecisionReason}
              reasons={reasons
                .filter((r) => !r.retiredAt)
                .map((r) => ({ value: r.code, label: r.label }))}
            />
          </div>
        )}
      </section>
    </div>
  )
}
