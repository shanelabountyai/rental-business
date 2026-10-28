'use server'

import { randomBytes } from 'node:crypto'
import { type AuditAction, recordAudit } from '@rental/core/audit'
import { hashPassword } from '@rental/core/auth'
import {
  LAST_PLATFORM_OWNER,
  PLATFORM_ROLE_DEFINITIONS,
  type PlatformRoleKey,
  platformDeactivationRefusal,
  platformGrantRefusal,
  platformMfaResetRefusal,
  platformRevokeRefusal,
  platformSetupLinkRefusal,
} from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { inviteEmail, minutesUntil, platformUrl, sendPlatformEmail } from '@/lib/platform/mail.ts'
import { issueToken } from '@/lib/auth/store.ts'

// `/platform/admins` (PRD 11 §4.8, R-302b). Every act is `platformAdmin.manage`,
// which is a step-up permission, so the guard alone asks for a fresh code.
// Every refusal is one of R-302a's pure functions, shown on the page before
// the press and asked again here; the deferred trigger is the guarantee
// behind the last-owner one.

export interface PlatformAdminFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
  /// The setup link, shown to the inviter as well as emailed - the same
  /// posture as the org's staff invite and the bootstrap script.
  setupUrl?: string
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

function isRoleKey(value: string): value is PlatformRoleKey {
  return Object.hasOwn(PLATFORM_ROLE_DEFINITIONS, value)
}

async function clientIp(): Promise<string> {
  return (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

/// Issues a setup link for an admin, emails it, and audits the send.
async function sendSetupLink(
  admin: { id: string; email: string; name: string },
  inviter: { id: string; name: string },
): Promise<{ url: string; minutes: number }> {
  const issued = await issueToken('PLATFORM_PASSWORD_SETUP', { type: 'PlatformAdmin', id: admin.id })
  const url = platformUrl(`/platform/set-password?token=${issued.token}`)
  const mail = inviteEmail(admin.name, inviter.name, url, issued.expiresAt)
  const outcome = await sendPlatformEmail(admin.email, mail.subject, mail.body)
  await recordAudit(prisma, {
    actor: { type: 'PLATFORM', ref: inviter.id, ipAddress: await clientIp() },
    action: 'platform_admin.setup_link_sent',
    entityType: 'PlatformAdmin',
    entityId: admin.id,
    orgId: null,
    after: { to: admin.email, status: outcome.status, reason: outcome.suppressedReason ?? outcome.failureCode ?? null },
  })
  return { url, minutes: minutesUntil(issued.expiresAt) }
}

export async function invitePlatformAdmin(
  _previous: PlatformAdminFormState,
  formData: FormData,
): Promise<PlatformAdminFormState> {
  const actor = await requirePlatform({ permission: 'platformAdmin.manage', next: '/platform/admins/new' })
  const email = str(formData, 'email').toLowerCase()
  const name = str(formData, 'name')
  const roleKey = str(formData, 'roleKey')

  const fieldErrors: Record<string, string> = {}
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.email = 'That does not look like an email address.'
  if (!name) fieldErrors.name = 'A name is required.'
  if (!isRoleKey(roleKey)) fieldErrors.roleKey = 'Pick one of the three platform roles.'
  if (Object.keys(fieldErrors).length > 0) return { error: 'Fix the highlighted fields.', fieldErrors }

  if (await prisma.platformAdmin.findUnique({ where: { email }, select: { id: true } })) {
    return { error: `${email} is already a platform admin.`, fieldErrors: { email: 'Already in use.' } }
  }

  // A random password nobody holds, as the bootstrap script does; the setup
  // link is the only way in.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
  const created = await prisma.$transaction(async (tx) => {
    const admin = await tx.platformAdmin.create({
      data: {
        email,
        name,
        createdById: actor.id,
        credential: { create: { passwordHash } },
        roles: { create: { roleKey, grantedById: actor.id } },
      },
    })
    await recordAudit(tx, {
      actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
      action: 'platform_admin.created',
      entityType: 'PlatformAdmin',
      entityId: admin.id,
      orgId: null,
      after: { email, roles: [roleKey] },
    })
    return admin
  })

  const link = await sendSetupLink(created, actor)
  revalidatePath('/platform/admins')
  return {
    notice: `${name} is invited. The link was emailed and is below too; it expires in about ${link.minutes} minutes.`,
    setupUrl: link.url,
  }
}

/**
 * Every act on one admin's page, dispatched on `intent`, so the page holds
 * ONE `useActionState` and one result region above panels the acts change.
 */
export async function managePlatformAdmin(
  _previous: PlatformAdminFormState,
  formData: FormData,
): Promise<PlatformAdminFormState> {
  const targetId = str(formData, 'adminId')
  const page = `/platform/admins/${encodeURIComponent(targetId)}`
  const actor = await requirePlatform({ permission: 'platformAdmin.manage', next: page })
  const intent = str(formData, 'intent')

  const target = await prisma.platformAdmin.findUnique({
    where: { id: targetId },
    include: { credential: { select: { mfaEnrolledAt: true } } },
  })
  if (!target) return { error: 'That admin no longer exists.' }
  const summary = { ...target, mfaEnrolledAt: target.credential?.mfaEnrolledAt ?? null }
  const audit = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    action: AuditAction,
    after: Record<string, unknown>,
  ) =>
    recordAudit(tx, {
      actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
      action,
      entityType: 'PlatformAdmin',
      entityId: target.id,
      orgId: null,
      after,
    })
  const done = (notice: string): PlatformAdminFormState => {
    revalidatePath(page)
    revalidatePath('/platform/admins')
    return { notice }
  }

  try {
    if (intent === 'grant') {
      const roleKey = str(formData, 'roleKey')
      if (!isRoleKey(roleKey)) return { error: 'Pick one of the three platform roles.' }
      const refusal = platformGrantRefusal(target.id, actor.id)
      if (refusal) return { error: refusal }
      if (!target.active) return { error: `${target.name} is deactivated. Nobody grants a role to an account that cannot sign in.` }
      const held = await prisma.platformRoleAssignment.findFirst({
        where: { platformAdminId: target.id, roleKey, revokedAt: null },
        select: { id: true },
      })
      if (held) return { error: `${target.name} already holds ${PLATFORM_ROLE_DEFINITIONS[roleKey].name}.` }
      await prisma.$transaction(async (tx) => {
        await tx.platformRoleAssignment.create({ data: { platformAdminId: target.id, roleKey, grantedById: actor.id } })
        await audit(tx, 'platform_role.granted', { roleKey })
      })
      return done(`${target.name} now holds ${PLATFORM_ROLE_DEFINITIONS[roleKey].name}.`)
    }

    if (intent === 'revoke') {
      const assignmentId = str(formData, 'assignmentId')
      const assignment = await prisma.platformRoleAssignment.findUnique({ where: { id: assignmentId } })
      if (!assignment || assignment.platformAdminId !== target.id) return { error: 'That assignment no longer exists.' }
      // Revoking your own is §3.3's one exception (a departing owner); only
      // granting to yourself is refused.
      const refusal = platformRevokeRefusal(assignmentId, await assignmentSummaries())
      if (refusal) return { error: refusal }
      await prisma.$transaction(async (tx) => {
        await tx.platformRoleAssignment.update({
          where: { id: assignmentId },
          data: { revokedAt: new Date(), revokedById: actor.id },
        })
        await audit(tx, 'platform_role.revoked', { roleKey: assignment.roleKey })
      })
      return done(`${target.name} no longer holds ${roleName(assignment.roleKey)}.`)
    }

    if (intent === 'resetMfa') {
      const refusal = platformMfaResetRefusal(summary, actor.id)
      if (refusal) return { error: refusal }
      await prisma.$transaction(async (tx) => {
        await tx.platformCredential.update({
          where: { platformAdminId: target.id },
          data: { mfaSecret: null, mfaEnrolledAt: null, mfaRecoveryCodes: [] },
        })
        await tx.platformAdmin.update({ where: { id: target.id }, data: { sessionsValidFrom: new Date() } })
        await audit(tx, 'auth.mfa_reset', { mfaCleared: true })
      })
      return done(`${target.name}'s two-factor is cleared and their sessions ended. Their next sign-in sets up a new device.`)
    }

    if (intent === 'deactivate') {
      const refusal = !target.active
        ? `${target.name} is already deactivated.`
        : platformDeactivationRefusal(target.id, actor.id, await assignmentSummaries())
      if (refusal) return { error: refusal }
      const now = new Date()
      await prisma.$transaction(async (tx) => {
        await tx.platformAdmin.update({
          where: { id: target.id },
          data: { active: false, deactivatedAt: now, sessionsValidFrom: now },
        })
        // ponytail: support grants arrive with R-295, which ends them here.
        await audit(tx, 'platform_admin.deactivated', { active: false })
      })
      return done(`${target.name} is deactivated. Every session they held has ended.`)
    }

    if (intent === 'resend') {
      const refusal = platformSetupLinkRefusal(summary)
      if (refusal) return { error: refusal }
      const link = await sendSetupLink(target, actor)
      revalidatePath(page)
      return {
        notice: `A new setup link was emailed to ${target.email} and is below; it expires in about ${link.minutes} minutes.`,
        setupUrl: link.url,
      }
    }
  } catch (error) {
    // The deferred trigger refused the commit: another owner was removed by
    // somebody else between this page's read and this press.
    if (error instanceof Error && error.message.includes(LAST_PLATFORM_OWNER)) return { error: LAST_PLATFORM_OWNER }
    throw error
  }
  return { error: 'That action is not recognised.' }
}

function roleName(roleKey: string): string {
  return isRoleKey(roleKey) ? PLATFORM_ROLE_DEFINITIONS[roleKey].name : roleKey
}

async function assignmentSummaries() {
  const rows = await prisma.platformRoleAssignment.findMany({
    where: { revokedAt: null },
    select: { id: true, platformAdminId: true, roleKey: true, revokedAt: true, platformAdmin: { select: { active: true } } },
  })
  return rows.map(({ platformAdmin, ...row }) => ({ ...row, adminActive: platformAdmin.active }))
}
