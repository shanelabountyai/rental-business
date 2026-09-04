import { parseServiceMethodMap } from '@rental/core/notices'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { SelectField } from '@/components/form/field.tsx'
import { RuleForm } from '@/components/jurisdiction/rule-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { createRuleVersion } from '@/lib/jurisdiction/actions.ts'
import { currentRuleVersion, listCurrentRules } from '@/lib/jurisdiction/queries.ts'

export const metadata = { title: 'New jurisdiction rule — Rental Operations' }

// No resource: per R-004 this only clears for a portfolio-wide
// jurisdiction.write grant, correct here since a JurisdictionRule applies by
// state, not by property or entity - see permissions.ts's own comment.
export default async function NewJurisdictionRulePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; jurisdiction?: string; cloneFrom?: string }>
}) {
  await requirePermission('jurisdiction.write')
  const { state, jurisdiction, cloneFrom } = await searchParams

  // Prefills the whole form from whatever is currently in force for this
  // (state, jurisdiction) pair, so adding a version means changing the one
  // number that changed rather than retyping twenty fields. Blank when this
  // is a genuinely new configuration.
  const previous =
    state != null ? await currentRuleVersion(state, jurisdiction ?? null) : null

  // R-162 (review finding 11): "start a state from an existing one" - only
  // offered while there is no `previous`, since adding a version to an
  // already-configured pair is the existing supersede flow, not a clone.
  // Statewide-only sources: cloning is meant to seed a state's baseline, not
  // graft one county's carve-out onto another state entirely.
  const [cloneSource, clonableRules] = await Promise.all([
    !previous && cloneFrom ? currentRuleVersion(cloneFrom, null) : null,
    !previous ? listCurrentRules(new Date()) : [],
  ])
  const clonableStates = [...new Set(clonableRules.filter((r) => !r.jurisdiction).map((r) => r.state))].sort()

  // The fields a clone actually carries: everything EXCEPT state,
  // jurisdiction, citation and reviewedBy. `state`/`jurisdiction` are the new
  // config's own identity, not the source's. `citation` is a reference to the
  // SOURCE state's statute - true there, meaningless (and misleading) here,
  // so it is never carried from a clone even though it IS carried when
  // merely superseding a version of the same jurisdiction below. `reviewedBy`
  // is never carried either way - a new version, cloned or not, is a new
  // legal question.
  const source = previous ?? cloneSource

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {previous
          ? 'New rule version'
          : cloneSource
            ? `New jurisdiction configuration, cloned from ${cloneSource.state}`
            : 'New jurisdiction configuration'}
      </h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        {previous
          ? `Supersedes v${previous.version}, in effect since ${friendlyBusinessDate(utcToBusinessDate(previous.effectiveFrom))}. The prior version stays on record (D-4) - nothing is edited or deleted.`
          : cloneSource
            ? `Every field below starts from ${cloneSource.state}'s current configuration - review each one against this state's own statute before saving. Citation and reviewer are required for a state's first version and are not carried from the clone.`
            : 'Adding a jurisdiction is adding a reviewed config record, not a release (D-4). A state\'s first version needs a citation and reviewer before it can govern a real tenancy.'}
      </p>

      {!previous && clonableStates.length > 0 && (
        <form
          method="get"
          className="flex flex-wrap items-end gap-3 rounded-md border p-4"
        >
          {state && <input type="hidden" name="state" value={state} />}
          {jurisdiction && <input type="hidden" name="jurisdiction" value={jurisdiction} />}
          <div className="min-w-48">
            <SelectField
              label="Clone from"
              name="cloneFrom"
              defaultValue={cloneFrom ?? ''}
              placeholder="Blank configuration"
              options={clonableStates.map((code) => ({ value: code, label: code }))}
            />
          </div>
          <button
            type="submit"
            className="border-input mb-0.5 flex min-h-11 items-center rounded-md border px-4 py-2 text-sm font-medium"
          >
            Load starting values
          </button>
        </form>
      )}

      <RuleForm
        action={createRuleVersion}
        submitLabel={previous ? 'Add version' : 'Create configuration'}
        defaults={{
          state: state ?? previous?.state,
          jurisdiction: jurisdiction ?? previous?.jurisdiction ?? undefined,
          graceDays: source?.graceDays ?? '',
          lateFeeType: source?.lateFeeType,
          lateFeeFlatDollars: source?.lateFeeFlatCents
            ? source.lateFeeFlatCents / 100
            : '',
          lateFeePercent: source?.lateFeePercentBps
            ? source.lateFeePercentBps / 100
            : '',
          lateFeeDailyDollars: source?.lateFeeDailyCents
            ? source.lateFeeDailyCents / 100
            : '',
          lateFeeMaxDollars: source?.lateFeeMaxCents
            ? source.lateFeeMaxCents / 100
            : '',
          lateFeeMaxPercent: source?.lateFeeMaxPercentBps
            ? source.lateFeeMaxPercentBps / 100
            : '',
          depositMaxPercent: source?.depositMaxBps
            ? source.depositMaxBps / 100
            : '',
          depositDispositionDays: source?.depositDispositionDays ?? '',
          depositEscrowRequired: source?.depositEscrowRequired,
          depositInterestRequired: source?.depositInterestRequired,
          preMoveOutWalkthroughRequired: source?.preMoveOutWalkthroughRequired ?? null,
          earlyTerminationRightExists: source?.earlyTerminationRightExists ?? null,
          earlyTerminationNoticeDays: source?.earlyTerminationNoticeDays ?? '',
          earlyTerminationDocumentationTypes: source?.earlyTerminationDocumentationTypes ?? [],
          preMoveOutWalkthroughDaysBefore: source?.preMoveOutWalkthroughDaysBefore ?? '',
          entryNoticeHours: source?.entryNoticeHours ?? '',
          payOrQuitDays: source?.payOrQuitDays ?? '',
          acceptanceWaivesNotice: source?.acceptanceWaivesNotice ?? null,
          acceptanceWaiverNote: source?.acceptanceWaiverNote ?? '',
          noticeToVacateDays: source?.noticeToVacateDays ?? '',
          rentIncreaseNoticeDays: source?.rentIncreaseNoticeDays ?? '',
          rentIncreaseCapPercent: source?.rentIncreaseCapPercentBps
            ? source.rentIncreaseCapPercentBps / 100
            : '',
          retaliationWindowDays: source?.retaliationWindowDays ?? '',
          abandonmentPresumedAfterDays: source?.abandonmentPresumedAfterDays ?? '',
          belongingsStorageDays: source?.belongingsStorageDays ?? '',
          // ?? rather than a truthiness check: 0 here means "the state
          // expressly requires no disposal notice" and must survive the
          // round trip - see the schema's own comment on the column.
          belongingsNoticeDays: source?.belongingsNoticeDays ?? '',
          leaseViolationCureDays: source?.leaseViolationCureDays ?? '',
          nsfFeePermitted: source?.nsfFeePermitted ?? true,
          nsfFeeMaxDollars: source?.nsfFeeMaxCents
            ? source.nsfFeeMaxCents / 100
            : '',
          cardSurchargePolicy: source?.cardSurchargePolicy,
          cardSurchargeMaxPercent: source?.cardSurchargeMaxBps
            ? source.cardSurchargeMaxBps / 100
            : '',
          noticeServiceMethods:
            parseServiceMethodMap(source?.noticeServiceMethods) ?? undefined,
          sourceOfIncomeProtected: source?.sourceOfIncomeProtected ?? null,
          justCauseRequired: source?.justCauseRequired,
          paymentAllocationOrder: source?.paymentAllocationOrder,
          applicationFeeCapDollars: source?.applicationFeeCapCents
            ? source.applicationFeeCapCents / 100
            : '',
          rubsPermitted: source?.rubsPermitted ?? true,
          // Citation is carried when superseding the SAME jurisdiction's own
          // version (still that state's statute), but never from a clone -
          // see the comment above `source`.
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
