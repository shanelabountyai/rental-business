import 'server-only'

import { type SupportGrantState, supportGrantStatus } from '@rental/core/rbac'
import { prisma } from '@rental/db'

// The console's reads about organisations (PRD 11 §4.2–4.4, R-303). PLAT-03
// holds every platform page to an allowlist of models and columns, so these
// select what they show and nothing else: an integration's status and never
// its `config` or `secret` (R-292b's Twilio panel shows named config keys,
// which hold nothing secret), an owner's name and email and nothing more.

/// `OrgHealth` is written at least daily; past this it is a dead cron, not a
/// quiet org (§4.2), and the numbers are replaced rather than shown stale.
export const HEALTH_STALE_MS = 26 * 60 * 60_000

export const INTEGRATION_SELECT = { provider: true, status: true, statusReason: true, updatedAt: true } as const

export const ORG_SUMMARY_SELECT = {
  id: true,
  slug: true,
  name: true,
  notificationsEnabled: true,
  createdAt: true,
  health: true,
  integrations: { select: INTEGRATION_SELECT, orderBy: { provider: 'asc' } },
  // Open grants only (not ended, not denied): what §4.2's first and fifth
  // reasons read. The lifecycle columns, never the reason text.
  supportGrants: {
    where: { endedAt: null, deniedAt: null },
    select: { kind: true, requestedAt: true, requestedMinutes: true, approvedAt: true, deniedAt: true, expiresAt: true, endedAt: true },
  },
} as const

/// A support request unanswered this long is on the dashboard (§4.2).
export const OLD_REQUEST_MS = 24 * 60 * 60_000

type Health = {
  computedAt: Date
  dailyAt: Date | null
  dailyOk: boolean | null
  deadLetters: number
}
type Summary = {
  notificationsEnabled: boolean
  health: Health | null
  integrations: { provider: string; status: string }[]
  supportGrants: (SupportGrantState & { requestedAt: Date })[]
}

export const healthIsStale = (health: { computedAt: Date } | null, now: Date) =>
  !health || now.getTime() - health.computedAt.getTime() > HEALTH_STALE_MS

/// Why an org is on the dashboard's "needs attention" list, in §4.2's order.
export function attentionReasons(org: Summary, now: Date): string[] {
  const reasons: string[] = []
  const { health } = org
  if (org.supportGrants.some((g) => g.kind === 'BREAK_GLASS' && supportGrantStatus(g, now) === 'live')) {
    reasons.push('Emergency access is open')
  }
  if (healthIsStale(health, now)) {
    reasons.push(health ? 'Health not reported in over 26 hours' : 'Health not yet reported')
  } else if (health!.dailyOk === false) {
    reasons.push('Last daily run failed')
  } else if (!health!.dailyAt || now.getTime() - health!.dailyAt.getTime() > HEALTH_STALE_MS) {
    reasons.push('Daily run has not run in over 26 hours')
  }
  if (health && !healthIsStale(health, now) && health.deadLetters > 0) {
    reasons.push(`${health.deadLetters} dead-lettered event${health.deadLetters === 1 ? '' : 's'}`)
  }
  for (const i of org.integrations) {
    if (i.status === 'FAILED' || i.status === 'RESTRICTED') reasons.push(`${providerName(i.provider)} ${i.status.toLowerCase()}`)
  }
  const old = org.supportGrants.filter(
    (g) => supportGrantStatus(g, now) === 'pending' && now.getTime() - g.requestedAt.getTime() > OLD_REQUEST_MS,
  ).length
  if (old > 0) reasons.push(`${old} support request${old === 1 ? '' : 's'} unanswered for over 24 hours`)
  if (!org.notificationsEnabled) reasons.push('Notifications switched off')
  return reasons
}

export function providerName(provider: string): string {
  return provider === 'QUICKBOOKS' ? 'QuickBooks' : provider === 'ESIGN' ? 'E-sign' : provider[0] + provider.slice(1).toLowerCase()
}

/// D-354: each active owner's name and email, for invites and support calls.
/// Nobody else on the staff, and nothing else about the owners.
export function orgOwners(orgId: string) {
  return prisma.staffUser.findMany({
    where: {
      active: true,
      orgMemberships: { some: { orgId, removedAt: null } },
      assignments: { some: { orgId, revokedAt: null, role: { key: 'owner' } } },
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  })
}
