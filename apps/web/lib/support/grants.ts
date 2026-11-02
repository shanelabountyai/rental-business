import 'server-only'

import { type SupportAccessContext } from '@rental/core/notifications'
import { durationLabel } from '@rental/core/rbac'
import { businessDate, friendlyTimestamp } from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/org-url.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { createTask } from '@/lib/tasks/create.ts'

// Support access grants, the org-facing half (PRD 11 §4.7, §4.14, §4.16,
// R-295a). Both the console's actions and the org's call these; neither side
// reads the other's session.

type Db = Prisma.TransactionClient | typeof prisma

/// The columns every lifecycle decision reads (`supportGrantStatus` & co).
export const GRANT_STATE = {
  kind: true,
  requestedMinutes: true,
  approvedAt: true,
  deniedAt: true,
  expiresAt: true,
  endedAt: true,
  ownersAcknowledgedAt: true,
} as const

/**
 * Stamps EXPIRY on grants whose window has passed (§5.3). Liveness never
 * waits for this - it is computed from `expiresAt` - but the OPEN partial
 * uniques do, so every writer that opens a grant calls this first in its own
 * transaction, and the nightly cron calls it for the record.
 */
export async function expireSupportGrants(orgId: string, db: Db = prisma, now = new Date()): Promise<number> {
  const { count } = await db.supportAccessGrant.updateMany({
    where: { orgId, endedAt: null, deniedAt: null, expiresAt: { lte: now } },
    data: { endedAt: now, endedByType: 'EXPIRY' },
  })
  return count
}

/// The zone an org's owners read times in: its oldest active property's.
/// ponytail: an org has no timezone column; Texas (the compliance default)
/// until it has a property. Add `Organization.timezone` when a second state
/// makes the guess wrong.
export async function orgTimezone(orgId: string): Promise<string> {
  const property = await prisma.property.findFirst({
    where: { orgId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { timezone: true },
  })
  return property?.timezone ?? 'America/Chicago'
}

/// Every active owner of the org (§4.7): an active account, a live membership
/// and a live portfolio-wide owner grant - the same test the database puts
/// on an approver. Phone is read here, for the SMS, and never by the console.
export function activeOwners(orgId: string) {
  return prisma.staffUser.findMany({
    where: {
      active: true,
      orgMemberships: { some: { orgId, removedAt: null } },
      assignments: { some: { orgId, revokedAt: null, propertyId: null, legalEntityId: null, role: { key: 'owner' } } },
    },
    select: { id: true, name: true, email: true, phone: true },
    orderBy: { name: 'asc' },
  })
}

/**
 * Tells the owners (§4.7, §4.16). Break-glass: every active owner, at once,
 * on every channel their preferences allow. A request: an email to each and
 * one Task in the org's queue (D-9). Through `notify()` only, addressed by
 * `orgId` because an org may have no property yet - which also means no
 * quiet hours, as "at once" wants. While the org's notifications are switched
 * off the rows are HELD and go out on switch-on (D-359, D-380); the banner
 * shows at once either way.
 */
export async function notifyOwnersOfGrant(grantId: string, now = new Date()): Promise<{ owners: number }> {
  const grant = await prisma.supportAccessGrant.findUniqueOrThrow({
    where: { id: grantId },
    select: {
      id: true,
      orgId: true,
      kind: true,
      reason: true,
      requestedMinutes: true,
      startsAt: true,
      expiresAt: true,
      organization: { select: { name: true } },
      platformAdmin: { select: { name: true } },
    },
  })
  const [owners, zone, url] = await Promise.all([
    activeOwners(grant.orgId),
    orgTimezone(grant.orgId),
    authUrl(grant.orgId, '/settings/support-access'),
  ])
  const context: SupportAccessContext = {
    orgName: grant.organization.name,
    adminName: grant.platformAdmin.name,
    reason: grant.reason,
    duration: durationLabel(grant.requestedMinutes),
    ...(grant.startsAt && { openedAt: friendlyTimestamp(grant.startsAt, zone) }),
    ...(grant.expiresAt && { endsAt: friendlyTimestamp(grant.expiresAt, zone) }),
    url,
  }
  const deliveryIds: string[] = []
  for (const owner of owners) {
    const outcomes = await notify({
      category: 'support_access',
      templateKey: grant.kind === 'BREAK_GLASS' ? 'support.break_glass' : 'support.requested',
      recipient: { type: 'STAFF', id: owner.id, email: owner.email, phone: owner.phone },
      context,
      orgId: grant.orgId,
      urgent: grant.kind === 'BREAK_GLASS',
      idempotencyKey: `support-grant:${grant.id}:${owner.id}`,
      now,
    })
    for (const outcome of outcomes) if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
  }
  if (grant.kind === 'REQUESTED') await raiseRequestTask(grant.id, grant.orgId, now)
  if (deliveryIds.length > 0) await dispatchPendingNotifications(now, 100, { deliveryIds })
  return { owners: owners.length }
}

async function raiseRequestTask(grantId: string, orgId: string, now: Date) {
  // ponytail: a Task needs a property, so an org-wide one lands on the org's
  // oldest active property, as R-277b's Stripe task does (the second org-wide
  // task type). An org with no property gets the email and the page only.
  // `Task.propertyId` nullable is the upgrade.
  const property = await prisma.property.findFirst({
    where: { orgId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, timezone: true },
  })
  if (!property) return
  await createTask(prisma, {
    propertyId: property.id,
    type: 'support_access_requested',
    subjectType: 'SupportAccessGrant',
    subjectId: grantId,
    businessDate: businessDate(now, property.timezone),
    priority: 'URGENT',
    title: 'Support is asking to view your organisation',
  })
}

/// Break-glass grants no owner has marked "Seen" (§4.16), newest first. The
/// banner stays after the grant ends: what it reports already happened.
export function unacknowledgedBreakGlass(orgId: string) {
  return prisma.supportAccessGrant.findMany({
    where: { orgId, kind: 'BREAK_GLASS', ownersAcknowledgedAt: null },
    select: { id: true, startsAt: true, platformAdmin: { select: { name: true } } },
    orderBy: { requestedAt: 'desc' },
  })
}
