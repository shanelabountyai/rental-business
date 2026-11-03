import 'server-only'

import { friendlyTimestamp } from '@rental/core/scheduling'
import { type OrgStatusContext } from '@rental/core/notifications'
import { freezeRefusal, purgeDate, restoreRefusal, scheduleOffboardRefusal } from '@rental/core/rbac'
import { type Prisma, prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/org-url.ts'
import { syncLeasePayer } from '@/lib/billing/lifecycle.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { activeOwners, orgTimezone } from '@/lib/support/grants.ts'

// The org's lifecycle writes (PRD 10 §8, PRD 11 §4.6, R-300a): freeze,
// restore, schedule offboarding. One function per transition, called from the
// console (platform admin, with a reason) and from /settings/export (the
// org's own owner). Each update is CONDITIONAL on the status it leaves, so
// two presses at once audit one transition, not two.
//
// The effects that are not rows run after the commit and never undo it: the
// owners' notice, and making Stripe agree (`syncLeasePayer` reads the org's
// status itself, so a sync that fails here is corrected by the next one).

export type LifecycleAudit = (
  tx: Prisma.TransactionClient,
  entry: { action: 'org.frozen' | 'org.restored' | 'org.offboard_scheduled'; before: Prisma.InputJsonObject; after: Prisma.InputJsonObject },
) => Promise<void>

type Outcome = { ok: true; purgeOn?: Date } | { ok: false; error: string }

export async function freezeOrg(orgId: string, by: OrgStatusContext['by'], reason: string | null, audit: LifecycleAudit): Promise<Outcome> {
  const now = new Date()
  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { status: true } })
    const refusal = freezeRefusal(org.status)
    if (refusal) return { ok: false, error: refusal }
    const { count } = await tx.organization.updateMany({ where: { id: orgId, status: 'ACTIVE' }, data: { status: 'FROZEN', frozenAt: now } })
    if (count === 0) return { ok: false, error: 'The organisation is already frozen.' }
    await audit(tx, { action: 'org.frozen', before: { status: 'ACTIVE' }, after: { status: 'FROZEN', ...(reason && { reason }) } })
    return { ok: true }
  })
  if (outcome.ok) await afterTransition(orgId, { change: 'frozen', by, ...(reason && { reason }) })
  return outcome
}

export async function restoreOrg(orgId: string, reason: string, audit: LifecycleAudit): Promise<Outcome> {
  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { status: true, offboardAt: true } })
    const refusal = restoreRefusal(org.status)
    if (refusal) return { ok: false, error: refusal }
    const { count } = await tx.organization.updateMany({
      where: { id: orgId, status: 'FROZEN' },
      data: { status: 'ACTIVE', frozenAt: null, offboardAt: null },
    })
    if (count === 0) return { ok: false, error: 'The organisation is not frozen.' }
    await audit(tx, {
      action: 'org.restored',
      before: { status: 'FROZEN', offboardAt: org.offboardAt?.toISOString() ?? null },
      after: { status: 'ACTIVE', reason },
    })
    return { ok: true }
  })
  if (outcome.ok) await afterTransition(orgId, { change: 'restored', by: 'platform', reason })
  return outcome
}

export async function scheduleOffboarding(orgId: string, reason: string, audit: LifecycleAudit): Promise<Outcome> {
  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { status: true, frozenAt: true, offboardAt: true } })
    const refusal = scheduleOffboardRefusal(org.status, org.offboardAt)
    if (refusal || !org.frozenAt) return { ok: false, error: refusal ?? 'Only a frozen organisation can be scheduled for offboarding.' }
    const offboardAt = purgeDate(org.frozenAt)
    const { count } = await tx.organization.updateMany({ where: { id: orgId, status: 'FROZEN', offboardAt: null }, data: { offboardAt } })
    if (count === 0) return { ok: false, error: 'Offboarding is already scheduled.' }
    await audit(tx, { action: 'org.offboard_scheduled', before: { offboardAt: null }, after: { offboardAt: offboardAt.toISOString(), reason } })
    return { ok: true, purgeOn: offboardAt }
  })
  if (outcome.ok) await afterTransition(orgId, { change: 'offboard_scheduled', by: 'platform', reason, purgeOn: outcome.purgeOn })
  return outcome
}

async function afterTransition(
  orgId: string,
  event: Pick<OrgStatusContext, 'change' | 'by' | 'reason'> & { purgeOn?: Date },
): Promise<void> {
  await notifyOwners(orgId, event)
  if (event.change !== 'offboard_scheduled') await syncOrgBilling(orgId)
}

/// Every active owner, on the org's own host and in its zone (§4.6).
async function notifyOwners(orgId: string, event: Pick<OrgStatusContext, 'change' | 'by' | 'reason'> & { purgeOn?: Date }) {
  const now = new Date()
  const [org, owners, zone, url] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }),
    activeOwners(orgId),
    orgTimezone(orgId),
    authUrl(orgId, '/settings/export'),
  ])
  const { purgeOn, ...rest } = event
  const context: OrgStatusContext = {
    orgName: org.name,
    ...rest,
    ...(purgeOn && { purgeOn: friendlyTimestamp(purgeOn, zone) }),
    url,
  }
  const deliveryIds: string[] = []
  for (const owner of owners) {
    const outcomes = await notify({
      category: 'org_status',
      templateKey: 'org.status_changed',
      recipient: { type: 'STAFF', id: owner.id, email: owner.email, phone: owner.phone },
      context,
      orgId,
      // One notice per owner per transition: the clock is the transition's.
      idempotencyKey: `org-status:${orgId}:${event.change}:${now.getTime()}:${owner.id}`,
      now,
    })
    for (const outcome of outcomes) if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
  }
  // At once rather than on the next drain: crons skip a frozen org.
  if (deliveryIds.length > 0) await dispatchPendingNotifications(now, 100, { deliveryIds })
}

/// "Subscriptions paused, not cancelled" (PRD 10 §8), and resumed on restore.
/// Each payer's sync reads the org's status itself; this only asks now.
export async function syncOrgBilling(orgId: string): Promise<void> {
  const payers = await prisma.leasePayer.findMany({
    where: { orgId, active: true, stripeSubscriptionId: { not: null } },
    select: { id: true },
  })
  // ponytail: one Stripe round trip per payer, in series; fine at 50 doors.
  for (const payer of payers) await syncLeasePayer(payer.id)
}

/// R-300b: the sentence a token link's write answers with in a FROZEN or
/// OFFBOARDED org. A vendor, applicant or signer holds no permission for
/// `actorForOrgStatus` to narrow, so each token-link ACTION asks this instead,
/// after its link verifies (reads stay open: frozen is read-only, not closed).
export const ORG_CLOSED_TO_CHANGES = 'This organisation is not taking changes through this link any more. Contact them directly.'

export async function orgClosedToChanges(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true } })
  return org?.status === 'FROZEN' || org?.status === 'OFFBOARDED'
}
