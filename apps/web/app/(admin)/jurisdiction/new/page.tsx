import { RuleForm } from '@/components/jurisdiction/rule-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { createRuleVersion } from '@/lib/jurisdiction/actions.ts'
import { currentRuleVersion } from '@/lib/jurisdiction/queries.ts'

export const metadata = { title: 'New jurisdiction rule — Rental Operations' }

// No resource: per R-004 this only clears for a portfolio-wide
// jurisdiction.write grant, correct here since a JurisdictionRule applies by
// state, not by property or entity - see permissions.ts's own comment.
export default async function NewJurisdictionRulePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; jurisdiction?: string }>
}) {
  await requirePermission('jurisdiction.write')
  const { state, jurisdiction } = await searchParams

  // Prefills the whole form from whatever is currently in force for this
  // (state, jurisdiction) pair, so adding a version means changing the one
  // number that changed rather than retyping twenty fields. Blank when this
  // is a genuinely new configuration.
  const previous =
    state != null ? await currentRuleVersion(state, jurisdiction ?? null) : null

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {previous ? 'New rule version' : 'New jurisdiction configuration'}
      </h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        {previous
          ? `Supersedes v${previous.version}, in effect since ${previous.effectiveFrom.toISOString().slice(0, 10)}. The prior version stays on record (D-4) - nothing is edited or deleted.`
          : 'Adding a jurisdiction is adding a reviewed config record, not a release (D-4).'}
      </p>
      <RuleForm
        action={createRuleVersion}
        submitLabel={previous ? 'Add version' : 'Create configuration'}
        defaults={{
          state: state ?? previous?.state,
          jurisdiction: jurisdiction ?? previous?.jurisdiction ?? undefined,
          graceDays: previous?.graceDays ?? '',
          lateFeeType: previous?.lateFeeType,
          lateFeeFlatDollars: previous?.lateFeeFlatCents
            ? previous.lateFeeFlatCents / 100
            : '',
          lateFeePercent: previous?.lateFeePercentBps
            ? previous.lateFeePercentBps / 100
            : '',
          lateFeeDailyDollars: previous?.lateFeeDailyCents
            ? previous.lateFeeDailyCents / 100
            : '',
          lateFeeMaxDollars: previous?.lateFeeMaxCents
            ? previous.lateFeeMaxCents / 100
            : '',
          lateFeeMaxPercent: previous?.lateFeeMaxPercentBps
            ? previous.lateFeeMaxPercentBps / 100
            : '',
          depositMaxPercent: previous?.depositMaxBps
            ? previous.depositMaxBps / 100
            : '',
          depositDispositionDays: previous?.depositDispositionDays ?? '',
          depositEscrowRequired: previous?.depositEscrowRequired,
          depositInterestRequired: previous?.depositInterestRequired,
          entryNoticeHours: previous?.entryNoticeHours ?? '',
          payOrQuitDays: previous?.payOrQuitDays ?? '',
          noticeToVacateDays: previous?.noticeToVacateDays ?? '',
          rentIncreaseNoticeDays: previous?.rentIncreaseNoticeDays ?? '',
          rentIncreaseCapPercent: previous?.rentIncreaseCapPercentBps
            ? previous.rentIncreaseCapPercentBps / 100
            : '',
          retaliationWindowDays: previous?.retaliationWindowDays ?? '',
          sourceOfIncomeProtected: previous?.sourceOfIncomeProtected ?? null,
          justCauseRequired: previous?.justCauseRequired,
          paymentAllocationOrder: previous?.paymentAllocationOrder,
          applicationFeeCapDollars: previous?.applicationFeeCapCents
            ? previous.applicationFeeCapCents / 100
            : '',
          rubsPermitted: previous?.rubsPermitted ?? true,
          citation: previous?.citation ?? undefined,
          notes: previous?.notes ?? undefined,
          // reviewedBy is deliberately NOT carried forward: a new version is
          // a new legal question, and defaulting this field to the prior
          // reviewer would make an un-reviewed change look signed off.
        }}
      />
    </div>
  )
}
