'use server'

import { type ScreeningCriteriaInput, validateCriteriaInput } from '@rental/core/screening'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { currentCriteriaVersion } from './criteria-queries.ts'

// Writes for ScreeningCriteria (R-242; OQ-6). Same shape as
// jurisdiction/actions.ts: one write only, adding a new effective-dated
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

  const previous = await currentCriteriaVersion()

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
