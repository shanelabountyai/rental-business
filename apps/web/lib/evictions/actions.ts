'use server'

import {
  canAdvanceTo,
  FILING_REFUSAL_MESSAGES,
  isEvictionCostType,
  isEvictionOutcome,
  isEvictionStage,
  readyToFile,
  STAGE_REFUSAL_MESSAGES,
  validateEvictionCost,
  type EvictionStageValue,
} from '@rental/core/evictions'
import { businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { cureClockFor, getEvictionCase } from '@/lib/evictions/queries.ts'

// Writes for eviction case files (PAY-14, R-083).
//
// NOTHING HERE FILES ANYTHING ANYWHERE. Every action records something a
// human already did or is scheduled to do. There is deliberately no
// integration with any court, clerk or process server, and adding one is a
// product decision nobody has made.

export interface EvictionFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
  documentId?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function optionalDate(formData: FormData, name: string): string | null {
  const value = str(formData, name)
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * Opens a case against a lease.
 *
 * The reason is REQUIRED and goes on the audit row, not only in a notes
 * field: `eviction.case_opened` is on REASON_REQUIRED, and "why did you
 * start evicting this person" is precisely what a retaliation defence asks.
 */
export async function openEvictionCase(
  _previous: EvictionFormState,
  formData: FormData,
): Promise<EvictionFormState> {
  const leaseId = str(formData, 'leaseId')
  const reason = str(formData, 'reason')

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: { id: true, propertyId: true, unitId: true, property: { select: { id: true, legalEntityId: true } } },
  })
  if (!lease) return { error: 'That lease no longer exists.' }

  const actor = await requirePermission('eviction.manage', propertyResource(lease.property))

  if (reason.length < 10) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: {
        reason: 'Say why this case is being opened — this is the record a retaliation claim is answered from.',
      },
    }
  }

  // One open case per lease. Two would be two files telling different
  // stories about the same tenancy, and an attorney handed both would have
  // to ask which one is real.
  const existing = await prisma.evictionCase.findFirst({
    where: { leaseId, stage: { not: 'CLOSED' } },
    select: { id: true },
  })
  if (existing) return { error: 'This lease already has an open eviction case.' }

  const created = await prisma.$transaction(async (tx) => {
    const evictionCase = await tx.evictionCase.create({
      data: {
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        leaseId: lease.id,
        openedByStaffId: actor.id,
        notes: reason,
      },
    })
    await audit(
      {
        action: 'eviction.case_opened',
        entityType: 'EvictionCase',
        entityId: evictionCase.id,
        propertyId: lease.propertyId,
        reason,
        after: { leaseId: lease.id, stage: 'NOTICE' },
      },
      tx,
    )
    return evictionCase
  })

  revalidatePath('/evictions')
  redirect(`/evictions/${created.id}`)
}

/// Files a served notice under a case. The notice itself is untouched - this
/// only sets its `evictionCaseId`, so R-051's generated, served,
/// proof-carrying row stays exactly as it was.
export async function attachNoticeToCase(
  caseId: string,
  _previous: EvictionFormState,
  formData: FormData,
): Promise<EvictionFormState> {
  const noticeId = str(formData, 'noticeId')
  const scope = await currentScope(await requirePermission('eviction.manage'))
  const evictionCase = await getEvictionCase(caseId, scope)
  if (!evictionCase) return { error: 'That case no longer exists.' }
  await requirePermission('eviction.manage', propertyResource(evictionCase.property))

  const notice = await prisma.notice.findUnique({
    where: { id: noticeId },
    select: { id: true, leaseId: true, evictionCaseId: true, type: true },
  })
  if (!notice || notice.leaseId !== evictionCase.leaseId) {
    return { error: 'That notice is not on this lease.' }
  }
  if (notice.evictionCaseId) return { error: 'That notice is already filed under a case.' }

  await prisma.$transaction(async (tx) => {
    await tx.notice.update({ where: { id: noticeId }, data: { evictionCaseId: caseId } })
    await audit(
      {
        action: 'eviction.notice_attached',
        entityType: 'EvictionCase',
        entityId: caseId,
        propertyId: evictionCase.propertyId,
        after: { noticeId, noticeType: notice.type },
      },
      tx,
    )
  })

  revalidatePath(`/evictions/${caseId}`)
  return { notice: 'Notice filed under this case.' }
}

/**
 * Moves a case to the next stage.
 *
 * TWO GATES, and the second is the point of the whole item. `canAdvanceTo`
 * refuses a stage out of order; `readyToFile` refuses a FILING that would be
 * made before the cure period ran out or on service the state does not name
 * - the two mistakes that get a case dismissed and everything started over.
 */
export async function advanceEvictionStage(
  caseId: string,
  _previous: EvictionFormState,
  formData: FormData,
): Promise<EvictionFormState> {
  const target = str(formData, 'stage')
  if (!isEvictionStage(target)) return { error: 'Choose a stage.' }

  const scope = await currentScope(await requirePermission('eviction.manage'))
  const evictionCase = await getEvictionCase(caseId, scope)
  if (!evictionCase) return { error: 'That case no longer exists.' }
  await requirePermission('eviction.manage', propertyResource(evictionCase.property))

  const decision = canAdvanceTo(evictionCase.stage as EvictionStageValue, target)
  if (!decision.allowed) return { error: STAGE_REFUSAL_MESSAGES[decision.refusal!] }

  if (target === 'CLOSED') return closeCase(evictionCase, formData)

  if (target === 'FILING') {
    const { clock, hasNotice } = await cureClockFor(evictionCase)
    const readiness = readyToFile(clock, hasNotice)
    if (!readiness.ready) return { error: FILING_REFUSAL_MESSAGES[readiness.refusal!] }
  }

  const stageDate = optionalDate(formData, 'stageDate')
  const courtDateTime = str(formData, 'courtDate')
  const data: Record<string, unknown> = { stage: target }
  if (target === 'FILING' && stageDate) data.filedOn = businessDateToUtc(stageDate)
  if (target === 'COURT' && courtDateTime) data.courtDate = new Date(courtDateTime)
  if (target === 'JUDGMENT' && stageDate) data.judgmentOn = businessDateToUtc(stageDate)
  if (target === 'WRIT' && stageDate) data.writOn = businessDateToUtc(stageDate)
  if (target === 'LOCKOUT' && stageDate) data.lockoutOn = businessDateToUtc(stageDate)

  await prisma.$transaction(async (tx) => {
    await tx.evictionCase.update({ where: { id: caseId }, data })
    await audit(
      {
        action: 'eviction.stage_changed',
        entityType: 'EvictionCase',
        entityId: caseId,
        propertyId: evictionCase.propertyId,
        before: { stage: evictionCase.stage },
        after: { stage: target, ...data },
      },
      tx,
    )
  })

  revalidatePath(`/evictions/${caseId}`)
  revalidatePath('/evictions')
  return { notice: 'Stage recorded.' }
}

async function closeCase(
  evictionCase: { id: string; propertyId: string; stage: string },
  formData: FormData,
): Promise<EvictionFormState> {
  const outcome = str(formData, 'outcome')
  const outcomeNote = str(formData, 'outcomeNote')
  if (!isEvictionOutcome(outcome)) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { outcome: 'Say how this case ended.' } }
  }
  if (outcomeNote.length < 10) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: {
        outcomeNote: 'Record the terms — a cash-for-keys sum, a judge’s reason. Somebody will ask later.',
      },
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.evictionCase.update({
      where: { id: evictionCase.id },
      data: { stage: 'CLOSED', outcome, outcomeNote, closedAt: new Date() },
    })
    await audit(
      {
        action: 'eviction.case_closed',
        entityType: 'EvictionCase',
        entityId: evictionCase.id,
        propertyId: evictionCase.propertyId,
        reason: outcomeNote,
        before: { stage: evictionCase.stage },
        after: { stage: 'CLOSED', outcome },
      },
      tx,
    )
  })

  revalidatePath(`/evictions/${evictionCase.id}`)
  revalidatePath('/evictions')
  // THIS NOTICE IS NEVER SEEN, and that is correct rather than a bug to fix
  // with a banner. Closing the case removes the whole "record what happened
  // next" section - including the panel this state would render in - so the
  // live region announcing it is unmounted in the same pass that would have
  // populated it (the self-replacing-panel trap auth-form.tsx documents at
  // length). What the user actually gets is better: the page now reads
  // "Closed" in its header and prints the outcome and its terms. Returned
  // anyway so the action's shape matches every sibling and a future caller
  // that keeps its panel mounted gets a sentence rather than silence.
  return { notice: 'Case closed.' }
}

export async function recordEvictionCost(
  caseId: string,
  _previous: EvictionFormState,
  formData: FormData,
): Promise<EvictionFormState> {
  const scope = await currentScope(await requirePermission('eviction.manage'))
  const evictionCase = await getEvictionCase(caseId, scope)
  if (!evictionCase) return { error: 'That case no longer exists.' }
  const actor = await requirePermission('eviction.manage', propertyResource(evictionCase.property))

  const dollars = Number(str(formData, 'amountDollars'))
  const input = {
    type: str(formData, 'type'),
    amountCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : Number.NaN,
    incurredOn: str(formData, 'incurredOn'),
    description: str(formData, 'description'),
  }
  const violations = validateEvictionCost(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.$transaction(async (tx) => {
    const cost = await tx.evictionCost.create({
      data: {
        evictionCaseId: caseId,
        type: isEvictionCostType(input.type) ? input.type : 'OTHER',
        amountCents: input.amountCents,
        incurredOn: businessDateToUtc(input.incurredOn),
        description: input.description,
        recordedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'eviction.cost_recorded',
        entityType: 'EvictionCase',
        entityId: caseId,
        propertyId: evictionCase.propertyId,
        after: { costId: cost.id, type: input.type, amountCents: input.amountCents },
      },
      tx,
    )
  })

  revalidatePath(`/evictions/${caseId}`)
  return { notice: 'Cost recorded.' }
}
