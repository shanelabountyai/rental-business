'use server'

import { recordAudit } from '@rental/core/audit'
import { mintToken } from '@rental/core/auth'
import { RESERVED_ORG_SLUGS, orgSlugRefusal } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { usableColor } from '@/lib/brand.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { deliverOverChannel } from '@/lib/notifications/deliver.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { minutesUntil, orgInviteEmail } from '@/lib/platform/mail.ts'

// `/platform/orgs/new` and the invites panel on `/platform/orgs/[slug]`
// (PRD 11 §4.5, R-304a, D-323, D-370). `org.create` is a step-up permission,
// so the guard alone asks for a fresh code on every press.
//
// The invite is mailed with `deliverOverChannel` under the NEW org's id - its
// kill switch and sender apply - and, like every invite here, the link is
// also shown to the inviter. There is no Notification row: the invitee has
// no StaffUser yet, and that table is keyed by a recipient (D-367's posture).
// The evidence is `org_invite.sent` in the org, carrying the outcome.

export interface OrgInviteFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
  setupUrl?: string
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

async function clientIp(): Promise<string> {
  return (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

function reservedSlugs(): string[] {
  const label = process.env.PLATFORM_HOST?.trim().toLowerCase().split('.')[0]
  return label ? [...RESERVED_ORG_SLUGS, label] : [...RESERVED_ORG_SLUGS]
}

/// Mails an invite whose token was just minted, and audits the send in the org.
async function sendInvite(
  invite: { id: string; orgId: string; email: string; name: string; expiresAt: Date },
  orgName: string,
  token: string,
  actor: { id: string; name: string },
  resent: boolean,
): Promise<{ url: string; minutes: number }> {
  const url = await authUrl(invite.orgId, `/invite/${token}`)
  const mail = orgInviteEmail(invite.name, orgName, actor.name, url, invite.expiresAt)
  const outcome = await deliverOverChannel({ channel: 'EMAIL', to: invite.email, ...mail, orgId: invite.orgId })
  await recordAudit(prisma, {
    actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
    action: 'org_invite.sent',
    entityType: 'OrgInvite',
    entityId: invite.id,
    orgId: invite.orgId,
    after: { to: invite.email, resent, status: outcome.status, reason: outcome.suppressedReason ?? outcome.failureCode ?? null },
  })
  return { url, minutes: minutesUntil(invite.expiresAt) }
}

function inDays(minutes: number): string {
  const days = Math.round(minutes / (60 * 24))
  return days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${minutes} minutes`
}

export async function createOrganization(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  const actor = await requirePlatform({ permission: 'org.create', next: '/platform/orgs/new' })
  const name = str(formData, 'name')
  const slug = str(formData, 'slug').toLowerCase()
  const ownerName = str(formData, 'ownerName')
  const ownerEmail = str(formData, 'ownerEmail').toLowerCase()

  const fieldErrors: Record<string, string> = {}
  if (!name) fieldErrors.name = 'A name is required.'
  const slugRefusal = orgSlugRefusal(slug, reservedSlugs())
  if (slugRefusal) fieldErrors.slug = slugRefusal
  if (!ownerName) fieldErrors.ownerName = 'A name is required.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) fieldErrors.ownerEmail = 'That does not look like an email address.'
  if (Object.keys(fieldErrors).length > 0) return { error: 'Fix the highlighted fields.', fieldErrors }

  // Slugs are public hostnames, so saying one is taken reveals nothing (§4.5).
  const taken = { error: `The slug “${slug}” is taken.`, fieldErrors: { slug: 'Already in use.' } }
  if (await prisma.organization.findUnique({ where: { slug }, select: { id: true } })) return taken

  const minted = mintToken('ORG_INVITE')
  let created
  try {
    created = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name, slug }, select: { id: true, name: true } })
      const invite = await tx.orgInvite.create({
        data: {
          orgId: org.id,
          email: ownerEmail,
          name: ownerName,
          roleKey: 'owner',
          tokenHash: minted.tokenHash,
          expiresAt: minted.expiresAt,
          invitedByType: 'PLATFORM',
          invitedById: actor.id,
        },
      })
      await recordAudit(tx, {
        actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
        action: 'org.created',
        entityType: 'Organization',
        entityId: org.id,
        orgId: org.id,
        after: { name, slug, ownerEmail },
      })
      return { org, invite }
    })
  } catch (error) {
    // A concurrent create took the slug between the check and the insert.
    if ((error as { code?: string }).code === 'P2002') return taken
    throw error
  }

  const link = await sendInvite(created.invite, created.org.name, minted.token, actor, false)
  revalidatePath('/platform/orgs')
  return {
    notice: `${name} is created and ${ownerName} is invited as its owner. The link was emailed and is below too; it expires in ${inDays(link.minutes)}.`,
    setupUrl: link.url,
  }
}

/**
 * "Resend" and "Revoke" on an org's pending invites, dispatched on `intent`,
 * so the panel holds ONE `useActionState` and one result region above the
 * list the acts change. Resend rotates the token on the same row, so the
 * link already sent stops working.
 */
export async function manageOrgInvite(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  // The page's slug comes from the form only to send the step-up back to it;
  // the invite's own org is what the act touches.
  const page = `/platform/orgs/${encodeURIComponent(str(formData, 'slug'))}`
  const actor = await requirePlatform({ permission: 'org.create', next: page })
  const invite = await prisma.orgInvite.findUnique({
    where: { id: str(formData, 'inviteId') },
    include: { organization: { select: { name: true } } },
  })
  if (!invite) return { error: 'That invitation no longer exists.' }
  if (invite.acceptedAt) return { error: `${invite.email} has already accepted.` }
  if (invite.revokedAt) return { error: 'That invitation was already revoked.' }

  const intent = str(formData, 'intent')
  if (intent === 'revoke') {
    await prisma.$transaction(async (tx) => {
      // Conditional, so a revoke cannot land on an invite accepted meanwhile.
      const { count } = await tx.orgInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (count === 0) return
      await recordAudit(tx, {
        actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
        action: 'org_invite.revoked',
        entityType: 'OrgInvite',
        entityId: invite.id,
        orgId: invite.orgId,
        after: { email: invite.email },
      })
    })
    revalidatePath(page)
    return { notice: `The invitation to ${invite.email} is revoked. Its link no longer works.` }
  }

  if (intent === 'resend') {
    const minted = mintToken('ORG_INVITE')
    const { count } = await prisma.orgInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { tokenHash: minted.tokenHash, expiresAt: minted.expiresAt },
    })
    if (count === 0) return { error: 'That invitation was accepted or revoked meanwhile.' }
    const link = await sendInvite(
      { ...invite, expiresAt: minted.expiresAt },
      invite.organization.name,
      minted.token,
      actor,
      true,
    )
    revalidatePath(page)
    return {
      notice: `A new link was emailed to ${invite.email} and is below; it expires in ${inDays(link.minutes)}. The previous link no longer works.`,
      setupUrl: link.url,
    }
  }
  return { error: 'That action is not recognised.' }
}

/**
 * "Edit name / brand colours" on `/platform/orgs/[slug]` (PRD 11 §4.6, R-304b).
 * A colour is refused unless it carries white text at AA - the same test
 * `brandStyle()` applies, which would otherwise drop it silently and leave the
 * admin believing it was live. Blank clears a colour back to Homestead's.
 */
export async function configureOrganization(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  const slug = str(formData, 'slug')
  const actor = await requirePlatform({ permission: 'org.configure', next: `/platform/orgs/${encodeURIComponent(slug)}` })
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true, colorPrimary: true, colorAccent: true } })
  if (!org) return { error: 'That organisation no longer exists.' }

  const name = str(formData, 'name')
  const fieldErrors: Record<string, string> = {}
  if (!name) fieldErrors.name = 'A name is required.'
  const colour = (key: 'colorPrimary' | 'colorAccent'): string | null => {
    const value = str(formData, key).toLowerCase()
    if (!value) return null
    if (!/^#[0-9a-f]{6}$/.test(value)) fieldErrors[key] = 'Use a colour like #1d4ed8.'
    else if (!usableColor(value)) fieldErrors[key] = 'Too light: white text on it would not reach 4.5:1. Choose a darker colour.'
    return value
  }
  const colorPrimary = colour('colorPrimary')
  const colorAccent = colour('colorAccent')
  if (Object.keys(fieldErrors).length > 0) return { error: 'Fix the highlighted fields.', fieldErrors }

  const before = { name: org.name, colorPrimary: org.colorPrimary, colorAccent: org.colorAccent }
  const after = { name, colorPrimary, colorAccent }
  if (JSON.stringify(before) === JSON.stringify(after)) return { notice: 'Nothing changed.' }

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: after })
    await recordAudit(tx, {
      actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
      action: 'org.configured',
      entityType: 'Organization',
      entityId: org.id,
      orgId: org.id,
      before,
      after,
    })
  })
  revalidatePath(`/platform/orgs/${slug}`)
  revalidatePath('/platform/orgs')
  return { notice: 'Saved. The organisation’s pages use the new name and colours now.' }
}

/**
 * "Change slug" (PRD 11 §4.6, R-304b): the organisation's host changes, so it
 * asks for a fresh code and the old slug typed back. Always allowed until
 * R-300 adds a status column to say the org is live. Cookies are host-only, so
 * signed-in staff are signed out of the old host, and a pending invitation's
 * link names the old host: both are said so rather than left as a surprise.
 */
export async function changeOrgSlug(
  _previous: OrgInviteFormState,
  formData: FormData,
): Promise<OrgInviteFormState> {
  const oldSlug = str(formData, 'slug')
  const actor = await requirePlatform({
    permission: 'org.configure',
    stepUp: true,
    next: `/platform/orgs/${encodeURIComponent(oldSlug)}`,
  })
  const org = await prisma.organization.findUnique({ where: { slug: oldSlug }, select: { id: true } })
  if (!org) return { error: 'That organisation no longer exists.' }

  if (str(formData, 'confirmSlug') !== oldSlug) {
    return { error: 'Type the current slug exactly to confirm.', fieldErrors: { confirmSlug: 'Does not match.' } }
  }
  const newSlug = str(formData, 'newSlug').toLowerCase()
  const refusal = newSlug === oldSlug ? 'That is already its slug.' : orgSlugRefusal(newSlug, reservedSlugs())
  if (refusal) return { error: refusal, fieldErrors: { newSlug: refusal } }

  const taken = { error: `The slug “${newSlug}” is taken.`, fieldErrors: { newSlug: 'Already in use.' } }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: org.id }, data: { slug: newSlug } })
      await recordAudit(tx, {
        actor: { type: 'PLATFORM', ref: actor.id, ipAddress: await clientIp() },
        action: 'org.slug_changed',
        entityType: 'Organization',
        entityId: org.id,
        orgId: org.id,
        before: { slug: oldSlug },
        after: { slug: newSlug },
      })
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return taken
    throw error
  }
  revalidatePath('/platform/orgs')
  redirect(`/platform/orgs/${encodeURIComponent(newSlug)}?slugChanged=${encodeURIComponent(oldSlug)}`)
}
