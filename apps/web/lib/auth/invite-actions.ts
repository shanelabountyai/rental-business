'use server'

import { recordAudit } from '@rental/core/audit'
import { hashPassword, hashToken, validatePassword } from '@rental/core/auth'
import { INVITE_REFUSED, inviteRefusal } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { FormState } from '@/components/auth-form.tsx'
import { hostOrgId } from '@/lib/auth/org.ts'

// `/invite/[token]` (PRD 11 §4.17, R-304a, D-370). The token is the
// credential, and it is honoured only on its own org's host (D-344): the org
// comes from the Host header, never from the invite, so a link opened on
// another org's host fails like a bad one.
//
// The account is the one with the invited email, created here if none exists
// (D-318: one StaffUser per human). An existing account keeps its password -
// accepting grants membership and the role to THAT account, which the link
// holder cannot use without its credentials - so it gets no password field.

class Refused extends Error {}

export async function acceptOrgInvite(_previous: FormState, formData: FormData): Promise<FormState> {
  const orgId = await hostOrgId()
  const token = String(formData.get('token') ?? '')
  const invite = token
    ? await prisma.orgInvite.findUnique({ where: { tokenHash: hashToken(token) } })
    : null
  const refusal = inviteRefusal(invite, orgId)
  if (refusal || !invite) return { error: refusal ?? INVITE_REFUSED }

  const existing = await prisma.staffUser.findUnique({ where: { email: invite.email }, select: { id: true, active: true } })
  if (existing && !existing.active) {
    return { error: 'That account is deactivated, so it cannot join. Ask whoever invited you.' }
  }
  let passwordHash: string | null = null
  if (!existing) {
    const password = String(formData.get('password') ?? '')
    if (password !== String(formData.get('confirmPassword') ?? '')) return { error: 'Those two passwords do not match.' }
    const violations = validatePassword(password)
    if (violations.length > 0) return { error: violations.map((v) => v.message).join(' ') }
    passwordHash = await hashPassword(password)
  }
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const now = new Date()

  try {
    await prisma.$transaction(async (tx) => {
      const user =
        existing ??
        (await tx.staffUser.create({
          data: { email: invite.email, name: invite.name, credential: { create: { passwordHash: passwordHash! } } },
          select: { id: true },
        }))
      // The claim. Conditional, so two presses - or a revoke landing between
      // the read above and here - cannot both win.
      const { count } = await tx.orgInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedById: user.id },
      })
      if (count === 0) throw new Refused()
      await tx.orgMembership.upsert({
        where: { orgId_staffUserId: { orgId: invite.orgId, staffUserId: user.id } },
        create: { orgId: invite.orgId, staffUserId: user.id },
        update: { removedAt: null },
      })
      const role = await tx.role.findUniqueOrThrow({ where: { key: invite.roleKey }, select: { id: true } })
      const held = await tx.staffAssignment.findFirst({
        where: { orgId: invite.orgId, staffUserId: user.id, roleId: role.id, propertyId: null, legalEntityId: null, revokedAt: null },
        select: { id: true },
      })
      if (!held) {
        await tx.staffAssignment.create({ data: { orgId: invite.orgId, staffUserId: user.id, roleId: role.id } })
      }
      await recordAudit(tx, {
        actor: { type: 'STAFF', ref: user.id, ipAddress: ip },
        action: 'org_invite.accepted',
        entityType: 'OrgInvite',
        entityId: invite.id,
        orgId: invite.orgId,
        after: { email: invite.email, roleKey: invite.roleKey, newAccount: !existing },
      })
    })
  } catch (error) {
    if (error instanceof Refused) return { error: INVITE_REFUSED }
    throw error
  }

  redirect('/login?invited=1')
}
