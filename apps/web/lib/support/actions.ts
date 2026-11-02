'use server'

import {
  durationLabel,
  supportAcknowledgeRefusal,
  supportApprovalRefusal,
  supportDenialRefusal,
  supportEndRefusal,
} from '@rental/core/rbac'
import type { Actor } from '@rental/core/rbac'
import { type Prisma, prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guard.ts'
import { verifyStaffStepUp } from '@/lib/auth/staff-step-up.ts'
import { audit } from '@/lib/audit/index.ts'
import { GRANT_STATE } from '@/lib/support/grants.ts'

// The org's answers to platform support (PRD 11 §4.14, §4.16, R-295a):
// approve, deny, revoke, and "Seen" on the break-glass banner. Owner-only:
// `staff.manage` AND `audit.read`, portfolio-wide - which a support session
// can never hold, so support cannot approve itself (§4.14, §6).
//
// NONE OF THESE REDIRECTS. On an org host a server action's `redirect()` came
// back as /login in e2e (D-379, not yet understood), so each returns its
// result to `useActionState` and the page re-renders in place.

export interface SupportAccessFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

const MISSING = 'That request no longer exists.'

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

async function requireOwner() {
  const actor = await requirePermission('staff.manage')
  await requirePermission('audit.read')
  return actor
}

/// The grant, only if it is this org's: another org's id answers exactly as a
/// missing one (ORG-04).
function grantInOrg(grantId: string, orgId: string) {
  return prisma.supportAccessGrant.findFirst({
    where: { id: grantId, orgId },
    select: { id: true, ...GRANT_STATE, platformAdmin: { select: { name: true } } },
  })
}

/// The request's Task (D-9) is answered by any answer.
function closeRequestTask(tx: Prisma.TransactionClient, grantId: string, staffUserId: string) {
  return tx.task.updateMany({
    where: { type: 'support_access_requested', subjectId: grantId, status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } },
    data: { status: 'DONE', completedByStaffId: staffUserId, completedAt: new Date() },
  })
}

/**
 * One action for the four answers (`intent`), so the page has ONE result
 * region, mounted outside every card: approving or denying a request removes
 * its card, and a region inside it would unmount with its own notice
 * (CLAUDE.md, Golden Path 5).
 */
export async function answerSupportAccess(
  _previous: SupportAccessFormState,
  formData: FormData,
): Promise<SupportAccessFormState> {
  const actor = await requireOwner()
  switch (str(formData, 'intent')) {
    case 'approve':
      return approveSupportGrant(actor, formData)
    case 'deny':
      return denySupportGrant(actor, formData)
    case 'revoke':
      return revokeSupportGrant(actor, formData)
    case 'seen':
      return acknowledgeBreakGlass(actor, formData)
    default:
      return { error: 'That action is not recognised.' }
  }
}

function refresh() {
  revalidatePath('/settings/support-access')
  revalidatePath('/dashboard')
}

async function approveSupportGrant(
  actor: Actor,
  formData: FormData,
): Promise<SupportAccessFormState> {
  const grant = await grantInOrg(str(formData, 'grantId'), actor.orgId)
  if (!grant) return { error: MISSING }
  const minutes = Number(str(formData, 'minutes'))
  const now = new Date()
  const refusal = supportApprovalRefusal(grant, minutes, now)
  if (refusal) return { error: refusal }
  // §4.14's step-up: a code at the press (D-380, `verifyStaffStepUp`).
  if (!(await verifyStaffStepUp(actor.id, str(formData, 'code')))) {
    return { error: 'That code did not work.', fieldErrors: { code: 'Enter the current code from your authenticator app.' } }
  }

  try {
    const approved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.supportAccessGrant.updateMany({
        where: { id: grant.id, orgId: actor.orgId, approvedAt: null, deniedAt: null, endedAt: null },
        data: {
          approvedByStaffId: actor.id,
          approvedAt: now,
          startsAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        },
      })
      if (count === 0) return false
      await closeRequestTask(tx, grant.id, actor.id)
      await audit(
        { action: 'support_grant.approved', entityType: 'SupportAccessGrant', entityId: grant.id, after: { minutes } },
        tx,
      )
      return true
    })
    if (!approved) return { error: 'That request is no longer waiting for an answer.' }
  } catch (error) {
    // The deferred approver trigger: a live owner-member, checked at commit.
    if (error instanceof Error && error.message.includes('Only a live owner')) {
      return { error: 'Only a live owner of this organisation can approve support access.' }
    }
    throw error
  }
  refresh()
  return { notice: `${grant.platformAdmin.name} has read-only access for ${durationLabel(minutes)}.` }
}

async function denySupportGrant(
  actor: Actor,
  formData: FormData,
): Promise<SupportAccessFormState> {
  const grant = await grantInOrg(str(formData, 'grantId'), actor.orgId)
  if (!grant) return { error: MISSING }
  const refusal = supportDenialRefusal(grant)
  if (refusal) return { error: refusal }
  const note = str(formData, 'note') || null

  const denied = await prisma.$transaction(async (tx) => {
    const { count } = await tx.supportAccessGrant.updateMany({
      where: { id: grant.id, orgId: actor.orgId, approvedAt: null, deniedAt: null, endedAt: null },
      data: { deniedByStaffId: actor.id, deniedAt: new Date(), denialNote: note },
    })
    if (count === 0) return false
    await closeRequestTask(tx, grant.id, actor.id)
    await audit(
      { action: 'support_grant.denied', entityType: 'SupportAccessGrant', entityId: grant.id, after: { note } },
      tx,
    )
    return true
  })
  if (!denied) return { error: 'That request is no longer waiting for an answer.' }
  refresh()
  return { notice: `The request from ${grant.platformAdmin.name} was denied.` }
}

async function revokeSupportGrant(
  actor: Actor,
  formData: FormData,
): Promise<SupportAccessFormState> {
  const grant = await grantInOrg(str(formData, 'grantId'), actor.orgId)
  if (!grant) return { error: MISSING }
  const now = new Date()
  const refusal = supportEndRefusal(grant, 'org', now)
  if (refusal) return { error: refusal }

  const ended = await prisma.$transaction(async (tx) => {
    const { count } = await tx.supportAccessGrant.updateMany({
      where: { id: grant.id, orgId: actor.orgId, endedAt: null, deniedAt: null, expiresAt: { gt: now } },
      data: { endedAt: now, endedByType: 'STAFF', endedById: actor.id },
    })
    if (count === 0) return false
    await audit({ action: 'support_grant.ended', entityType: 'SupportAccessGrant', entityId: grant.id, after: { by: 'STAFF' } }, tx)
    return true
  })
  if (!ended) return { error: 'That grant is no longer open.' }
  refresh()
  return { notice: `Access for ${grant.platformAdmin.name} has ended.` }
}

async function acknowledgeBreakGlass(
  actor: Actor,
  formData: FormData,
): Promise<SupportAccessFormState> {
  const grant = await grantInOrg(str(formData, 'grantId'), actor.orgId)
  if (!grant) return { error: MISSING }
  const refusal = supportAcknowledgeRefusal(grant)
  if (refusal) return { error: refusal }

  const seen = await prisma.$transaction(async (tx) => {
    // Conditional, so two owners pressing at once record one acknowledgement.
    const { count } = await tx.supportAccessGrant.updateMany({
      where: { id: grant.id, orgId: actor.orgId, kind: 'BREAK_GLASS', ownersAcknowledgedAt: null },
      data: { ownersAcknowledgedAt: new Date(), acknowledgedByStaffId: actor.id },
    })
    if (count === 0) return false
    await audit({ action: 'support_grant.acknowledged', entityType: 'SupportAccessGrant', entityId: grant.id }, tx)
    return true
  })
  if (!seen) return { notice: 'Another owner has already marked this as seen.' }
  refresh()
  return { notice: 'Marked as seen for every owner.' }
}
