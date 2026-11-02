'use server'

import { recordAudit } from '@rental/core/audit'
import { BREAK_GLASS_MINUTES, supportEndRefusal, supportRequestRefusal } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { GRANT_STATE, expireSupportGrants, notifyOwnersOfGrant } from '@/lib/support/grants.ts'

// The console's half of support access (PRD 11 §4.7, R-295a): ask an org for
// access, break the glass, and end a grant you hold. Every write is audited
// in the org as PLATFORM, in the grant's own transaction (PLAT-04), and names
// the grant (`supportGrantId`, §5.4). Nothing here lets anybody in yet:
// entering is R-295b's.

export interface SupportGrantFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

const ALREADY_OPEN = 'You already have an open request or grant for this organisation. End it before asking again.'

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

async function clientIp(): Promise<string> {
  return (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

function refresh(slug: string) {
  revalidatePath(`/platform/orgs/${slug}/support`)
  revalidatePath('/platform/grants')
}

/// A normal request (§4.7): REQUESTED, nothing opens until an owner approves.
export async function requestSupportAccess(
  _previous: SupportGrantFormState,
  formData: FormData,
): Promise<SupportGrantFormState> {
  const slug = str(formData, 'slug')
  const actor = await requirePlatform({ permission: 'grant.request' })
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } })
  if (!org) return { error: 'That organisation no longer exists.' }

  const reason = str(formData, 'reason')
  const minutes = Number(str(formData, 'minutes'))
  const refusal = supportRequestRefusal(reason, minutes)
  if (refusal) return { error: 'Check the highlighted fields.', fieldErrors: refusal }

  const ip = await clientIp()
  let grantId: string
  try {
    grantId = await prisma.$transaction(async (tx) => {
      await expireSupportGrants(org.id, tx)
      const grant = await tx.supportAccessGrant.create({
        data: { orgId: org.id, platformAdminId: actor.id, kind: 'REQUESTED', reason, requestedMinutes: minutes },
        select: { id: true },
      })
      await recordAudit(tx, {
        actor: { type: 'PLATFORM', ref: actor.id, ipAddress: ip },
        action: 'support_grant.requested',
        entityType: 'SupportAccessGrant',
        entityId: grant.id,
        orgId: org.id,
        supportGrantId: grant.id,
        reason,
        after: { requestedMinutes: minutes },
      })
      return grant.id
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { error: ALREADY_OPEN }
    throw error
  }
  const { owners } = await notifyOwnersOfGrant(grantId)
  refresh(slug)
  return { notice: `Requested. ${ownersSentence(owners)} Nothing opens until one of them approves.` }
}

/**
 * Break-glass (§4.7): opens at once for a fixed hour, no approver, step-up
 * (a step-up permission, so the guard asks for the code). At most one live
 * per org (partial unique). The owners are told at once and the dashboard
 * carries a banner until one presses "Seen".
 */
export async function openBreakGlass(
  _previous: SupportGrantFormState,
  formData: FormData,
): Promise<SupportGrantFormState> {
  const slug = str(formData, 'slug')
  const actor = await requirePlatform({
    permission: 'grant.breakGlass',
    next: `/platform/orgs/${encodeURIComponent(slug)}/support`,
  })
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } })
  if (!org) return { error: 'That organisation no longer exists.' }

  const reason = str(formData, 'reason')
  if (!reason) return { error: 'A reason is required.', fieldErrors: { breakGlassReason: 'Say why. The owners read it word for word.' } }

  const ip = await clientIp()
  let grantId: string
  try {
    grantId = await prisma.$transaction(async (tx) => {
      await expireSupportGrants(org.id, tx)
      const now = new Date()
      const grant = await tx.supportAccessGrant.create({
        data: {
          orgId: org.id,
          platformAdminId: actor.id,
          kind: 'BREAK_GLASS',
          reason,
          requestedMinutes: BREAK_GLASS_MINUTES,
          startsAt: now,
          expiresAt: new Date(now.getTime() + BREAK_GLASS_MINUTES * 60_000),
        },
        select: { id: true },
      })
      await recordAudit(tx, {
        actor: { type: 'PLATFORM', ref: actor.id, ipAddress: ip },
        action: 'support_grant.break_glass_opened',
        entityType: 'SupportAccessGrant',
        entityId: grant.id,
        orgId: org.id,
        supportGrantId: grant.id,
        reason,
        after: { minutes: BREAK_GLASS_MINUTES },
      })
      return grant.id
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: 'This organisation already has live emergency access, or you already hold an open grant here.' }
    }
    throw error
  }
  const { owners } = await notifyOwnersOfGrant(grantId)
  refresh(slug)
  return { notice: `Emergency access is open for ${BREAK_GLASS_MINUTES} minutes. ${ownersSentence(owners)}` }
}

function ownersSentence(owners: number): string {
  return owners === 0
    ? 'The organisation has no active owner to tell.'
    : `${owners} owner${owners === 1 ? ' was' : 's were'} told.`
}

/**
 * "End now" (§4.7): withdraws your own pending request or ends your own live
 * grant. Only an admin's own - it removes access and grants none, so it needs
 * a session and no permission, like signing out everywhere.
 */
export async function endSupportGrant(
  _previous: SupportGrantFormState,
  formData: FormData,
): Promise<SupportGrantFormState> {
  const actor = await requirePlatform()
  const grant = await prisma.supportAccessGrant.findFirst({
    where: { id: str(formData, 'grantId'), platformAdminId: actor.id },
    select: { id: true, orgId: true, organization: { select: { slug: true } }, ...GRANT_STATE },
  })
  if (!grant) return { error: 'That grant no longer exists.' }
  const now = new Date()
  const refusal = supportEndRefusal(grant, 'platform', now)
  if (refusal) return { error: refusal }

  const ip = await clientIp()
  const ended = await prisma.$transaction(async (tx) => {
    const { count } = await tx.supportAccessGrant.updateMany({
      where: { id: grant.id, endedAt: null, deniedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      data: { endedAt: now, endedByType: 'PLATFORM', endedById: actor.id },
    })
    if (count === 0) return false
    await recordAudit(tx, {
      actor: { type: 'PLATFORM', ref: actor.id, ipAddress: ip },
      action: 'support_grant.ended',
      entityType: 'SupportAccessGrant',
      entityId: grant.id,
      orgId: grant.orgId,
      supportGrantId: grant.id,
      after: { by: 'PLATFORM' },
    })
    return true
  })
  if (!ended) return { error: 'That grant is no longer open.' }
  refresh(grant.organization.slug)
  return { notice: 'Ended.' }
}
