'use server'

import {
  CRITERION_LABELS,
  type CriterionKey,
  type ScreeningCriteriaInput,
  validateCriteriaInput,
} from '@rental/core/screening'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { currentCriteriaVersion } from './criteria-queries.ts'

// Writes for ScreeningCriteria (R-242; OQ-6). Same shape as
// platform/jurisdiction-actions.ts: one write only, adding a new effective-dated
// version - there is no update or delete, because a version that already
// governed an applicant's decision must stay exactly as it was.

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

function optionalNumber(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Number(raw) : null
}

function criteriaInputFrom(formData: FormData): ScreeningCriteriaInput {
  const multiplier = optionalNumber(formData, 'incomeToRentMultiplier')
  return {
    // Typed as a human ratio ("3" meaning 3x rent), stored x100 the same way
    // the schema's own doc comment describes - Math.round guards the classic
    // float error (3.1 * 100 = 309.99999...).
    incomeToRentMultiplierX100: multiplier != null ? Math.round(multiplier * 100) : Number.NaN,
    minCreditScore: optionalNumber(formData, 'minCreditScore'),
    evictionLookbackMonths: optionalNumber(formData, 'evictionLookbackMonths') ?? Number.NaN,
    criminalLookbackMonths: optionalNumber(formData, 'criminalLookbackMonths') ?? Number.NaN,
    citation: str(formData, 'citation') || null,
    reviewedBy: str(formData, 'reviewedBy') || null,
    notes: str(formData, 'notes') || null,
  }
}

/**
 * Adds a new effective-dated ScreeningCriteria version, closing out whichever
 * version was open-ended before it.
 *
 * Portfolio-wide only: `requirePermission('screening.criteria.write')`
 * carries no resource, which per R-004's `can()` only ever clears for a
 * portfolio-wide grant - correct here, since criteria apply to every
 * applicant across the whole portfolio at once (ScreeningCriteria's own doc
 * comment), not per property or entity.
 */
export async function createCriteriaVersion(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('screening.criteria.write')

  const input = criteriaInputFrom(formData)
  const violations = validateCriteriaInput(input)
  if (violations.length > 0) return violationsToState(violations)

  const effectiveFromRaw = str(formData, 'effectiveFrom')
  const effectiveFrom = new Date(`${effectiveFromRaw}T00:00:00.000Z`)
  if (!effectiveFromRaw || Number.isNaN(effectiveFrom.getTime())) {
    return violationsToState([
      { field: 'effectiveFrom', message: 'Effective date is required.' },
    ])
  }

  const previous = await currentCriteriaVersion(actor.orgId)

  if (previous && effectiveFrom <= previous.effectiveFrom) {
    return {
      error: 'The new version must take effect after the version it replaces.',
      fieldErrors: {
        effectiveFrom: `Must be later than ${friendlyBusinessDate(utcToBusinessDate(previous.effectiveFrom))}, when the current version took effect.`,
      },
    }
  }

  const version = (previous?.version ?? 0) + 1

  await prisma.$transaction(async (tx) => {
    if (previous) {
      const closesOn = new Date(effectiveFrom)
      closesOn.setUTCDate(closesOn.getUTCDate() - 1)
      await tx.screeningCriteria.update({
        where: { id: previous.id },
        data: { effectiveTo: closesOn },
      })
    }

    const created = await tx.screeningCriteria.create({
      data: {
        // R-297: the org's own sequence, numbered from its own last version.
        orgId: actor.orgId,
        version,
        incomeToRentMultiplierX100: input.incomeToRentMultiplierX100,
        minCreditScore: input.minCreditScore,
        evictionLookbackMonths: input.evictionLookbackMonths,
        criminalLookbackMonths: input.criminalLookbackMonths,
        citation: input.citation,
        reviewedBy: input.reviewedBy,
        notes: input.notes,
        effectiveFrom,
        createdByStaffId: actor.id,
      },
    })

    await audit(
      {
        action: 'screening_criteria.versioned',
        entityType: 'ScreeningCriteria',
        entityId: created.id,
        before: previous ? { version: previous.version, effectiveFrom: previous.effectiveFrom } : null,
        after: { version: created.version, effectiveFrom: created.effectiveFrom, reviewedBy: created.reviewedBy },
      },
      tx,
    )
  })

  revalidatePath('/screening-criteria')
  redirect('/screening-criteria?versioned=1')
}

const CRITERIA = Object.keys(CRITERION_LABELS) as CriterionKey[]

export interface ReasonFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

/**
 * Adds a decision reason to the actor's org (R-297, PRD 10 §7.1). It must
 * name the written criterion it rests on; there is no reason without one.
 * Labels are never edited, so a code a past decision recorded keeps its
 * meaning (D-333): a reworded reason is a new reason and a retired old one.
 */
export async function addDecisionReason(_previous: ReasonFormState, formData: FormData): Promise<ReasonFormState> {
  const actor = await requirePermission('screening.criteria.write')
  const label = str(formData, 'label')
  const criterion = str(formData, 'criterion') as CriterionKey
  const fieldErrors: Record<string, string> = {}
  if (!label) fieldErrors.label = 'Say what the reason is.'
  else if (label.length > 200) fieldErrors.label = 'Keep the reason under 200 characters.'
  if (!CRITERIA.includes(criterion)) fieldErrors.criterion = 'Choose the written criterion this reason rests on.'
  if (Object.keys(fieldErrors).length > 0) return { error: 'Fix the highlighted fields.', fieldErrors }

  // A readable code from the label, unique in the org. Never shown to an
  // applicant; it is what a decision and its audit row record.
  const stem = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'REASON'
  const taken = new Set(
    (await prisma.decisionReason.findMany({
      where: { orgId: actor.orgId, code: { startsWith: stem } },
      select: { code: true },
    })).map((r) => r.code),
  )
  let code = stem
  for (let n = 2; taken.has(code); n++) code = `${stem}_${n}`

  await prisma.$transaction(async (tx) => {
    await tx.decisionReason.create({ data: { orgId: actor.orgId, code, label, criterion } })
    await audit(
      {
        action: 'decision_reason.added',
        entityType: 'DecisionReason',
        entityId: code,
        after: { code, label, criterion },
      },
      tx,
    )
  })
  revalidatePath('/screening-criteria')
  return { notice: `Added "${label}".` }
}

/** Retires a reason in the actor's org. Past decisions keep it. */
export async function retireDecisionReason(_previous: ReasonFormState, formData: FormData): Promise<ReasonFormState> {
  const actor = await requirePermission('screening.criteria.write')
  const code = str(formData, 'code')
  const reason = code
    ? await prisma.decisionReason.findFirst({ where: { orgId: actor.orgId, code, retiredAt: null } })
    : null
  if (!reason) return { error: 'That reason is not on the active list.' }

  await prisma.$transaction(async (tx) => {
    await tx.decisionReason.update({
      where: { orgId_code: { orgId: actor.orgId, code } },
      data: { retiredAt: new Date() },
    })
    await audit(
      {
        action: 'decision_reason.retired',
        entityType: 'DecisionReason',
        entityId: code,
        before: { code, label: reason.label, criterion: reason.criterion },
      },
      tx,
    )
  })
  revalidatePath('/screening-criteria')
  return { notice: `Retired "${reason.label}". Decisions that recorded it keep it.` }
}
