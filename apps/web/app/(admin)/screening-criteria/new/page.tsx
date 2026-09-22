import { CriteriaForm } from '@/components/screening/criteria-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { createCriteriaVersion } from '@/lib/screening/criteria-actions.ts'
import { currentCriteriaVersion } from '@/lib/screening/criteria-queries.ts'

export const metadata = { title: 'New screening criteria — Rental Operations' }

// No resource: per R-004 this only clears for a portfolio-wide
// screening.criteria.write grant - see permissions.ts's own comment.
export default async function NewScreeningCriteriaPage() {
  await requirePermission('screening.criteria.write')
  const previous = await currentCriteriaVersion()

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        New criteria version
      </h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        {previous
          ? `Supersedes v${previous.version}. The prior version stays on record - nothing is edited or deleted. Every field below starts from it; change only what changed.`
          : 'The first configured criteria - screening cannot run without a version to compare against.'}
      </p>

      <CriteriaForm
        action={createCriteriaVersion}
        submitLabel={previous ? 'Add version' : 'Create criteria'}
        defaults={{
          incomeToRentMultiplier: previous
            ? previous.incomeToRentMultiplierX100 / 100
            : '',
          minCreditScore: previous?.minCreditScore ?? '',
          evictionLookbackMonths: previous?.evictionLookbackMonths ?? '',
          criminalLookbackMonths: previous?.criminalLookbackMonths ?? '',
          citation: previous?.citation ?? undefined,
          notes: previous?.notes ?? undefined,
          // reviewedBy is deliberately NOT carried forward, the same reason
          // jurisdiction/new/page.tsx gives: a new version is a new legal
          // question, and defaulting this field to the prior reviewer would
          // make an unreviewed change look signed off.
        }}
      />
    </div>
  )
}
