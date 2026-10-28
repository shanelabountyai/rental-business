import 'server-only'

import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { deliverOverChannel } from '@/lib/notifications/deliver.ts'

// Mail to platform admins (PRD 11 §2.5, §4.8; R-302b, D-367). An admin
// belongs to no org, so these go through `deliverOverChannel` with
// `orgId: null`: the global kill switch and the sandbox redirect still apply,
// the operator's own sender sends, EMAIL only.
//
// NO Notification ROW. That table, its preferences and its retry sweep are
// all keyed by org and by a tenant/staff/guarantor recipient, and a platform
// admin is none of those. The evidence is an org-less audit row naming the
// recipient and the outcome, written by the caller in the same breath as the
// act it is about. Nothing retries a FAILED send: the inviter sees the link
// on screen anyway, and a lockout is also in the audit log.

/// An absolute URL on PLATFORM_HOST. Built from AUTH_URL's protocol and port,
/// as `authUrl` builds an org's, and never from the request's Host header -
/// a forged Host must not be able to choose where a setup link points.
export function platformUrl(path: string): string {
  const base = process.env.AUTH_URL
  const host = process.env.PLATFORM_HOST?.trim().toLowerCase()
  if (!base || !host) throw new Error('AUTH_URL and PLATFORM_HOST must be set to build a console link.')
  const url = new URL(path, base)
  url.hostname = host
  return url.toString()
}

export function minutesUntil(expiresAt: Date, now = Date.now()): number {
  return Math.max(1, Math.round((expiresAt.getTime() - now) / 60_000))
}

export async function sendPlatformEmail(to: string, subject: string, body: string) {
  return deliverOverChannel({ channel: 'EMAIL', to, subject, body, orgId: null })
}

export function inviteEmail(name: string, inviterName: string, url: string, expiresAt: Date) {
  return {
    subject: 'You have been added to the platform console',
    body: [
      `Hello ${name},`,
      '',
      `${inviterName} added you as a platform admin. Open this link to set a password:`,
      url,
      '',
      `It works once and expires in ${minutesUntil(expiresAt)} minutes. After the password you will set up two-factor authentication.`,
      '',
      'If you did not expect this, ignore it and tell whoever runs the platform.',
    ].join('\n'),
  }
}

/**
 * §2.5: an admin's account just locked. Every OTHER active platform owner is
 * told, because a lockout is either a forgotten password or somebody trying
 * one, and only another owner can tell which. Never throws: it runs after the
 * sign-in response (`after()`), where an exception reaches nobody.
 */
export async function notifyOwnersOfLockout(locked: { id: string; email: string }, ip: string) {
  try {
    const owners = await prisma.platformAdmin.findMany({
      where: {
        id: { not: locked.id },
        active: true,
        roles: { some: { roleKey: 'platform_owner', revokedAt: null } },
      },
      select: { id: true, email: true },
    })
    const body = [
      `The platform admin account ${locked.email} was locked after repeated wrong passwords, from ${ip}.`,
      '',
      'If that was not them, sign in to the console, reset their two-factor or deactivate the account, and look at the audit log.',
      'It unlocks by itself after the lockout period.',
    ].join('\n')
    const sent: { recipientId: string; status: string }[] = []
    for (const owner of owners) {
      const outcome = await sendPlatformEmail(owner.email, 'A platform admin account was locked', body)
      sent.push({ recipientId: owner.id, status: outcome.status })
    }
    await recordAudit(prisma, {
      actor: { type: 'PLATFORM', ref: 'platform:lockout-notice' },
      action: 'auth.lockout_notified',
      entityType: 'PlatformAdmin',
      entityId: locked.id,
      orgId: null,
      after: { sent },
    })
  } catch (error) {
    console.error(`[platform] lockout notice for ${locked.id} failed`, error)
  }
}
