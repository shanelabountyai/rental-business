'use server'

import {
  type JurisdictionRuleInput,
  validateJurisdictionRule,
} from '@rental/core/jurisdiction'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { currentRuleVersion } from './queries.ts'

// Writes for JurisdictionRule (R-010, D-4). One shape only: adding a new
// effective-dated version. There is no update or delete - "rule changes apply
// prospectively, never retroactively" means an existing version is never
// edited, only superseded, so the audit trail is the version history itself.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Blank -> null, unparseable -> NaN (never silently 0) - matches
/// apps/web/lib/units/actions.ts's identical helper and the NaN-guarded
/// range checks in validateJurisdictionRule that depend on it.
function optionalNumber(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Number(raw) : null
}

/// Blank -> null (unreviewed), 'true'/'false' -> the boolean - the tri-state
/// SelectField's own values, matching optionalNumber's identical shape.
function optionalBoolean(formData: FormData, name: string): boolean | null {
  const raw = str(formData, name)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function optionalCents(formData: FormData, name: string): number | null {
  const dollars = optionalNumber(formData, name)
  return dollars != null ? Math.round(dollars * 100) : null
}

/// Whole percent typed by a human ("10" meaning 10%) to the basis points the
/// schema stores (1000). Multiplying floats by 100 the naive way
/// (percent * 100) risks the classic 10.1 * 100 = 1009.9999... float error;
/// rounding after the multiply is the one-line fix.
function optionalBps(formData: FormData, name: string): number | null {
  const percent = optionalNumber(formData, name)
  return percent != null ? Math.round(percent * 100) : null
}

function ruleInputFrom(formData: FormData): JurisdictionRuleInput {
  return {
    state: str(formData, 'state'),
    jurisdiction: str(formData, 'jurisdiction') || null,
    effectiveFrom: new Date(`${str(formData, 'effectiveFrom')}T00:00:00.000Z`),
    graceDays: optionalNumber(formData, 'graceDays') ?? Number.NaN,
    lateFeeType: str(formData, 'lateFeeType'),
    lateFeeFlatCents: optionalCents(formData, 'lateFeeFlatDollars'),
    lateFeePercentBps: optionalBps(formData, 'lateFeePercent'),
    lateFeeDailyCents: optionalCents(formData, 'lateFeeDailyDollars'),
    lateFeeMaxCents: optionalCents(formData, 'lateFeeMaxDollars'),
    lateFeeMaxPercentBps: optionalBps(formData, 'lateFeeMaxPercent'),
    depositMaxBps: optionalBps(formData, 'depositMaxPercent'),
    depositDispositionDays: optionalNumber(formData, 'depositDispositionDays'),
    depositEscrowRequired: formData.get('depositEscrowRequired') === 'on',
    depositInterestRequired: formData.get('depositInterestRequired') === 'on',
    preMoveOutWalkthroughRequired: optionalBoolean(formData, 'preMoveOutWalkthroughRequired'),
    preMoveOutWalkthroughDaysBefore: optionalNumber(formData, 'preMoveOutWalkthroughDaysBefore'),
    entryNoticeHours: optionalNumber(formData, 'entryNoticeHours'),
    payOrQuitDays: optionalNumber(formData, 'payOrQuitDays'),
    noticeToVacateDays: optionalNumber(formData, 'noticeToVacateDays'),
    rentIncreaseNoticeDays: optionalNumber(formData, 'rentIncreaseNoticeDays'),
    rentIncreaseCapPercentBps: optionalBps(formData, 'rentIncreaseCapPercent'),
    retaliationWindowDays: optionalNumber(formData, 'retaliationWindowDays'),
    sourceOfIncomeProtected: optionalBoolean(formData, 'sourceOfIncomeProtected'),
    justCauseRequired: formData.get('justCauseRequired') === 'on',
    paymentAllocationOrder: formData.getAll('paymentAllocationOrder').map(String),
    applicationFeeCapCents: optionalCents(formData, 'applicationFeeCapDollars'),
    rubsPermitted: formData.get('rubsPermitted') === 'on',
    citation: str(formData, 'citation') || null,
    reviewedBy: str(formData, 'reviewedBy') || null,
    notes: str(formData, 'notes') || null,
  }
}

/**
 * Adds a new effective-dated version for a (state, jurisdiction) pair,
 * closing out whichever version was open-ended before it.
 *
 * Portfolio-wide only: `requirePermission('jurisdiction.write')` carries no
 * resource, which per R-004's `can()` only ever clears for a portfolio-wide
 * grant - correct here, since a JurisdictionRule applies by state, not by
 * property or entity, and there is no scoped resource to check it against.
 */
export async function createRuleVersion(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('jurisdiction.write')

  const input = ruleInputFrom(formData)
  const violations = validateJurisdictionRule(input)
  if (violations.length > 0) return violationsToState(violations)

  const previous = await currentRuleVersion(
    input.state,
    input.jurisdiction ?? null,
  )
  if (previous && input.effectiveFrom <= previous.effectiveFrom) {
    return {
      error: 'The new version must take effect after the version it replaces.',
      fieldErrors: {
        effectiveFrom: `Must be later than ${previous.effectiveFrom.toISOString().slice(0, 10)}, when the current version took effect.`,
      },
    }
  }

  const version = (previous?.version ?? 0) + 1

  await prisma.$transaction(async (tx) => {
    if (previous) {
      // The day before the new version starts, never the new version's own
      // effectiveFrom - a rule is in force through the end of the day it is
      // superseded, and the two ranges must not overlap or leave a gap.
      const closesOn = new Date(input.effectiveFrom)
      closesOn.setUTCDate(closesOn.getUTCDate() - 1)
      await tx.jurisdictionRule.update({
        where: { id: previous.id },
        data: { effectiveTo: closesOn },
      })
    }

    const created = await tx.jurisdictionRule.create({
      data: {
        state: input.state,
        jurisdiction: input.jurisdiction,
        version,
        effectiveFrom: input.effectiveFrom,
        graceDays: input.graceDays,
        lateFeeType: input.lateFeeType as never,
        lateFeeFlatCents: input.lateFeeFlatCents,
        lateFeePercentBps: input.lateFeePercentBps,
        lateFeeDailyCents: input.lateFeeDailyCents,
        lateFeeMaxCents: input.lateFeeMaxCents,
        lateFeeMaxPercentBps: input.lateFeeMaxPercentBps,
        depositMaxBps: input.depositMaxBps,
        depositDispositionDays: input.depositDispositionDays,
        depositEscrowRequired: input.depositEscrowRequired,
        depositInterestRequired: input.depositInterestRequired,
        preMoveOutWalkthroughRequired: input.preMoveOutWalkthroughRequired,
        preMoveOutWalkthroughDaysBefore: input.preMoveOutWalkthroughDaysBefore,
        entryNoticeHours: input.entryNoticeHours,
        payOrQuitDays: input.payOrQuitDays,
        noticeToVacateDays: input.noticeToVacateDays,
        rentIncreaseNoticeDays: input.rentIncreaseNoticeDays,
        rentIncreaseCapPercentBps: input.rentIncreaseCapPercentBps,
        retaliationWindowDays: input.retaliationWindowDays,
        sourceOfIncomeProtected: input.sourceOfIncomeProtected,
        justCauseRequired: input.justCauseRequired,
        paymentAllocationOrder: input.paymentAllocationOrder,
        applicationFeeCapCents: input.applicationFeeCapCents,
        rubsPermitted: input.rubsPermitted,
        citation: input.citation,
        reviewedBy: input.reviewedBy,
        notes: input.notes,
      },
    })

    await audit(
      {
        action: 'jurisdiction_rule.versioned',
        entityType: 'JurisdictionRule',
        entityId: created.id,
        before: previous
          ? { version: previous.version, effectiveFrom: previous.effectiveFrom }
          : null,
        after: {
          state: created.state,
          jurisdiction: created.jurisdiction,
          version: created.version,
          effectiveFrom: created.effectiveFrom,
        },
      },
      tx,
    )
  })

  revalidatePath('/jurisdiction')
  redirect(`/jurisdiction?versioned=${encodeURIComponent(input.state)}`)
}
