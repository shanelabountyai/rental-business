'use server'

import {
  LOCK_CHANGE_SCOPE,
  restrictedPartyNote,
  validateConfidentialCase,
} from '@rental/core/confidential'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { getConfidentialCase } from './queries.ts'

// Writes for confidential safety cases (RISK-04, ROLE-05; R-091).
//
// ==========================================================================
// EVERY EXPORT IS BEHIND `confidential.manage`, WHICH IS PRIVILEGED.
//
// Ordering a lock change and retiring the codes a restricted party may know
// are acts somebody's physical safety rests on, so they need a proved second
// factor - the same call R-084 makes for `hold.lift_protected` and for the
// same reason: it is not the reading that does harm, it is the doing.
//
// NOTHING HERE PUTS CASE CONTENT INTO AN AUDIT PAYLOAD. `AuditLog` is the
// table `audit.read` exists to expose broadly; an audit trail that quotes the
// record it is protecting has moved the secret rather than kept it. Every
// entry below carries the case id, and the closure reason, and nothing else.
//
// NOTHING HERE RAISES A `Task`, and that is deliberate - it is the opposite
// of the gap four consecutive items have left behind. `Task.title` is free
// text read by everyone holding `task.read`, which is the manager, the
// maintenance tech and the read-only partner, so a task saying anything
// useful about this case would be the leak, and one saying nothing useful is
// noise in somebody else's queue. The register orders open cases oldest
// first instead.
// ==========================================================================

export interface ConfidentialFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function caseForWrite(caseId: string) {
  // `requireScope` first, NEVER a resource-less `requirePermission` - an
  // empty resource only ever matches a portfolio-wide grant (see
  // `requireScope`'s own comment), so the obvious version of this refuses
  // every entity- or property-scoped owner and the whole case file stops
  // working for them. It shipped that way here and the e2e scoping test is
  // what found it.
  const { actor } = await requireScope('confidential.manage')
  const scope = await currentScope(actor)
  const found = await getConfidentialCase(caseId, scope)
  if (!found) return null
  // THEN the real authorization, against this case's own property.
  // `currentScope` is the switcher's selection; `can()` is the permission.
  await requirePermission('confidential.manage', propertyResource(found.lease.property))
  return { found, actor }
}

/**
 * Opens a case on a tenancy.
 *
 * OPENS ON A LEASE IN ANY STATE, including one already ended. The risk does
 * not stop when the tenancy does, and an operator who has just been told
 * something at 11pm should not meet a refusal because the lease ended last
 * week.
 */
export async function openConfidentialCase(
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const leaseId = str(formData, 'leaseId')
  if (!leaseId) return { error: 'No tenancy named.' }

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      status: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true, timezone: true } },
    },
  })
  if (!lease) return { error: 'That tenancy could not be found.' }
  const actor = await requirePermission('confidential.manage', propertyResource(lease.property))

  const input = {
    summary: str(formData, 'summary'),
    restrictedPartyName: str(formData, 'restrictedPartyName'),
    restrictedPartyTenantId: str(formData, 'restrictedPartyTenantId') || null,
    documentationType: str(formData, 'documentationType'),
    documentedOn: str(formData, 'documentedOn'),
    today: businessDate(new Date(), lease.property.timezone),
  }
  const violations = validateConfidentialCase(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.confidentialCase.create({
      data: {
        leaseId: lease.id,
        summary: input.summary,
        restrictedPartyName: input.restrictedPartyName || null,
        restrictedPartyTenantId: input.restrictedPartyTenantId,
        documentationType: input.documentationType || null,
        documentedOn: input.documentedOn ? businessDateToUtc(input.documentedOn) : null,
        documentationSeenByStaffId: input.documentationType ? actor.id : null,
        openedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'confidential.case_opened',
        entityType: 'ConfidentialCase',
        entityId: row.id,
        propertyId: lease.propertyId,
        // The case id and nothing else. See this file's own header.
        after: { caseId: row.id },
      },
      tx,
    )
    return row
  })

  redirect(`/confidential/${created.id}`)
}

/**
 * Records documentation, or revises the summary and the restricted party.
 *
 * Documentation is recorded here rather than demanded at opening: a survivor
 * who has not yet been to court has no order to show, and a product that
 * would not change the locks until they did would be holding somebody's
 * safety against a filing deadline.
 */
export async function updateConfidentialCase(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found, actor } = context
  if (found.status === 'CLOSED') return { error: 'This case is closed.' }

  const input = {
    summary: str(formData, 'summary'),
    restrictedPartyName: str(formData, 'restrictedPartyName'),
    restrictedPartyTenantId: str(formData, 'restrictedPartyTenantId') || null,
    documentationType: str(formData, 'documentationType'),
    documentedOn: str(formData, 'documentedOn'),
    today: businessDate(new Date(), found.lease.property.timezone),
  }
  const violations = validateConfidentialCase(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: {
        summary: input.summary,
        restrictedPartyName: input.restrictedPartyName || null,
        restrictedPartyTenantId: input.restrictedPartyTenantId,
        documentationType: input.documentationType || null,
        documentedOn: input.documentedOn ? businessDateToUtc(input.documentedOn) : null,
        // Re-stamped to whoever most recently said they saw it. The person
        // who looked at the order is the fact worth holding, and the person
        // who looked at it LAST is the one still able to answer for it.
        documentationSeenByStaffId: input.documentationType ? actor.id : null,
      },
    })
    await audit(
      {
        action: 'confidential.case_updated',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        // Which FIELDS changed, never their values.
        after: {
          caseId,
          documentationRecorded: Boolean(input.documentationType),
          restrictedPartyNamed: Boolean(input.restrictedPartyName),
        },
      },
      tx,
    )
  })

  revalidatePath(`/confidential/${caseId}`)
  return { notice: 'Case updated.' }
}

/**
 * Orders the re-key, and retires the access codes on file.
 *
 * TWO ACTS IN ONE BUTTON, because they are one decision and separating them
 * is how the second gets forgotten. The work order changes the physical
 * locks; retiring the codes stops THIS SYSTEM handing out a code the
 * restricted party may already know - to a vendor through
 * `revealAccessCode`, or to a tenant through `issueAccessCodeToTenant`.
 *
 * RETIRING A CODE CHANGES NO LOCK. It closes out our record so nothing here
 * discloses it again; the work order is what makes the door different. The
 * page says so, because an operator who believed otherwise would stop after
 * this and think the unit was secure.
 */
export async function orderLockChange(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context
  if (found.lockChangeWorkOrderId) {
    return { error: 'A re-key has already been ordered from this case.' }
  }

  const callbackLabel = str(formData, 'callbackLabel')
  if (!callbackLabel) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: {
        callbackLabel:
          'Give the name and number the locksmith should ring if anybody else asks about this job.',
      },
    }
  }

  // Who MAY be handed keys: whoever is on the tenancy, minus the restricted
  // party if they are one of them. Never a list of who may not - see
  // `restrictedPartyNote`'s own comment.
  const authorizedNames = found.lease.leaseTenants
    .filter((lt) => lt.tenant.id !== found.restrictedPartyTenantId)
    .map((lt) => `${lt.tenant.firstName} ${lt.tenant.lastName}`)

  const note = restrictedPartyNote({ authorizedNames, callbackLabel })

  const workOrderId = await prisma.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.create({
      data: {
        propertyId: found.lease.propertyId,
        unitId: found.lease.unitId,
        // URGENT, not EMERGENCY. Emergency is R-029's after-hours paging
        // tier, and a page that wakes a rota carries text into SMS and
        // voicemail on several phones - the widest possible surface for a
        // job whose whole point is that it is not discussed. Urgent puts it
        // at the top of the queue without broadcasting it.
        priority: 'URGENT',
        scope: LOCK_CHANGE_SCOPE,
        restrictedPartyNote: note,
      },
    })
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: { lockChangeWorkOrderId: workOrder.id },
    })
    // The ordinary, readable record that a job exists. Says nothing about a
    // case - this is the entry a dispatcher's audit view would show.
    await audit(
      {
        action: 'workorder.created',
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        propertyId: found.lease.propertyId,
        after: { scope: workOrder.scope, priority: workOrder.priority, ticketId: null },
      },
      tx,
    )
    await audit(
      {
        action: 'confidential.lock_change_ordered',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        after: { caseId, workOrderId: workOrder.id },
      },
      tx,
    )

    // Every code still open-ended on this unit. `effectiveTo` is R-005's own
    // retirement mechanism (see `addAccessCode`), reused rather than a second
    // notion of "retired" - a code with an end date is already what every
    // reader here means by "no longer current".
    const live = await tx.accessCode.findMany({
      where: { unitId: found.lease.unitId, effectiveTo: null },
      select: { id: true },
    })
    if (live.length > 0) {
      await tx.accessCode.updateMany({
        where: { id: { in: live.map((c) => c.id) } },
        data: { effectiveTo: new Date() },
      })
      await audit(
        {
          action: 'confidential.codes_retired',
          entityType: 'ConfidentialCase',
          entityId: caseId,
          propertyId: found.lease.propertyId,
          // How many, never which.
          after: { caseId, unitId: found.lease.unitId, retiredCount: live.length },
        },
        tx,
      )
    }
    return workOrder.id
  })

  revalidatePath(`/confidential/${caseId}`)
  return {
    notice: `Re-key ordered as work order ${workOrderId.slice(-6)}. Assign it to a locksmith from the work-order queue.`,
  }
}

/**
 * Closes the case. REASON_REQUIRED - a decision that a safety risk has passed
 * is the one somebody asks about afterwards, and it is the only case content
 * that crosses into `AuditLog`.
 */
export async function closeConfidentialCase(
  caseId: string,
  _previous: ConfidentialFormState,
  formData: FormData,
): Promise<ConfidentialFormState> {
  const context = await caseForWrite(caseId)
  if (!context) return { error: 'That case no longer exists.' }
  const { found } = context
  if (found.status === 'CLOSED') return { error: 'This case is already closed.' }

  const closedNote = str(formData, 'closedNote')
  if (!closedNote) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { closedNote: 'Say how this ended.' },
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.confidentialCase.update({
      where: { id: caseId },
      data: { status: 'CLOSED', closedAt: new Date(), closedNote },
    })
    await audit(
      {
        action: 'confidential.case_closed',
        entityType: 'ConfidentialCase',
        entityId: caseId,
        propertyId: found.lease.propertyId,
        reason: closedNote,
        after: { caseId },
      },
      tx,
    )
  })

  revalidatePath(`/confidential/${caseId}`)
  return { notice: 'Case closed.' }
}
