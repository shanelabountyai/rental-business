'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { smartLockAdapter } from '@/lib/locks/provider.ts'
import { revokeShowingAccessFor } from './revoke.ts'

// STAFF writes for Showing (LEASE-08, R-064) - separate from actions.ts,
// which has to stay import-clean of lib/audit/index.ts (and therefore of
// Auth.js) so it can be tested with no session at all. Same wall
// prospects/staff-actions.ts's own header documents.

export interface CancelResult {
  error?: string
}

/**
 * Withdraws a booked showing - a prospect calls to cancel, or the unit is
 * no longer available. Also cancels the escort Task raised at booking
 * (D-9): a cancelled showing with an open Task would sit in the staff
 * queue forever pointing at a visit that is not happening.
 *
 * The entry notice, if one was served, is left alone - a cancelled showing
 * does not un-serve a notice that already went out, and no other flow reads
 * `Showing.entryNoticeId` to imply the visit still stands.
 */
export async function cancelShowing(showingId: string): Promise<CancelResult> {
  const showing = await prisma.showing.findUniqueOrThrow({
    where: { id: showingId },
    include: { property: true },
  })
  await requirePermission('lease.write', propertyResource(showing.property))

  if (showing.status === 'CANCELED') {
    return { error: 'Already cancelled.' }
  }

  // R-094. THE CODE DIES WITH THE SHOWING, at the device. Without this a
  // cancelled viewing leaves a stranger holding digits that still open the
  // door, while every screen in the product says "cancelled" - our page
  // refusing to display a code is not the lock refusing to open.
  const revoked = await revokeShowingAccessFor(showingId, {
    reason: 'The viewing was cancelled.',
    staffId: null,
  })

  await prisma.$transaction(async (tx) => {
    await tx.showing.update({
      where: { id: showingId },
      data: { status: 'CANCELED', canceledAt: new Date() },
    })
    await tx.task.updateMany({
      where: { subjectType: 'Showing', subjectId: showingId, status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } },
      data: { status: 'CANCELED', completedAt: new Date() },
    })
    await audit(
      {
        action: 'showing.canceled',
        entityType: 'Showing',
        entityId: showingId,
        propertyId: showing.propertyId,
        before: { status: showing.status },
        after: { status: 'CANCELED' },
      },
      tx,
    )
  })

  if (revoked) {
    await audit({
      action: 'showing.access_revoked',
      entityType: 'Showing',
      entityId: showingId,
      propertyId: showing.propertyId,
      reason: 'The viewing was cancelled.',
      after: { reachedDevice: revoked.reachedDevice },
    })
  }

  revalidatePath(`/prospects/${showing.prospectId}`)
  revalidatePath(`/units/${showing.unitId}`)
  return revoked && !revoked.reachedDevice
    ? {
        error:
          'Cancelled, but the lock did not answer when the entry code was pulled — treat that code as still working until you have confirmed it at the device.',
      }
    : {}
}

// ---------------------------------------------------------------------------
// R-094: the instant kill, and the entry log
// ---------------------------------------------------------------------------

export interface AccessAdminState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

/**
 * Pulls a prospect's entry code (LEASE-08's "instant code kill").
 *
 * DELIBERATELY NOT PRIVILEGED, and that is a decision rather than an
 * oversight. R-084 settled the shape of it for holds: gating the SAFE
 * direction behind MFA is how the safe direction stops being taken. Somebody
 * who has just learned that a stranger has a live code for an empty house
 * must be able to pull it from whatever device is in their hand, without
 * finding an authenticator first. Issuing is what needs the ceremony, and
 * issuing is not a staff act at all - it is bought by an identity check.
 *
 * REASON REQUIRED, enforced here and by a database CHECK. A code pulled with
 * no stated reason is indistinguishable from a mis-click, and "why was this
 * cancelled" is exactly what somebody standing at a locked door asks.
 */
export async function revokeShowingAccess(
  showingId: string,
  _previous: AccessAdminState,
  formData: FormData,
): Promise<AccessAdminState> {
  const showing = await prisma.showing.findUniqueOrThrow({
    where: { id: showingId },
    include: { property: true },
  })
  const actor = await requirePermission('lease.write', propertyResource(showing.property))

  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) {
    return {
      error: 'Fix the highlighted field.',
      fieldErrors: { reason: 'Say why the code is being pulled.' },
    }
  }

  const outcome = await revokeShowingAccessFor(showingId, { reason, staffId: actor.id })
  if (!outcome) return { error: 'There is no live code on this viewing.' }

  await audit({
    action: 'showing.access_revoked',
    entityType: 'Showing',
    entityId: showingId,
    propertyId: showing.propertyId,
    reason,
    after: { reachedDevice: outcome.reachedDevice },
  })

  revalidatePath(`/units/${showing.unitId}`)
  return {
    notice: outcome.reachedDevice
      ? 'Code pulled. It no longer opens the door.'
      : 'Recorded, but the lock did not answer — TREAT THE CODE AS STILL WORKING until you have confirmed it at the device or changed the lock.',
  }
}

/**
 * Reads the entry log back from the device (LEASE-08's "entry logs").
 *
 * FROM THE DEVICE, NEVER FROM OUR OWN STATE. A log assembled from the codes
 * we believe we issued would agree with us by construction (D-27) and could
 * never show the entry nobody expected - which is the only kind of entry an
 * entry log is worth keeping for.
 *
 * `unit.read`, not `unit.write`, even though it inserts rows. It writes only
 * what the device already said, invents nothing, and is idempotent on the
 * device's own event id - so anybody who may look at the log may also make
 * it current, which is what somebody trying to work out who was in a house
 * last night actually needs.
 */
export async function syncLockEvents(unitId: string): Promise<AccessAdminState> {
  const unit = await prisma.unit.findUniqueOrThrow({
    where: { id: unitId },
    include: { property: true, smartLock: true },
  })
  await requirePermission('unit.read', propertyResource(unit.property))
  if (!unit.smartLock) return { error: 'This unit has no smart lock on file.' }

  const newest = await prisma.lockEvent.findFirst({
    where: { smartLockId: unit.smartLock.id },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  })
  // Thirty days on a first sync, and from the newest event we hold after
  // that. Overlapping deliberately: the unique on (lock, providerRef) makes
  // a re-fetched event free, and an event arriving out of order at the
  // boundary would otherwise be lost for ever.
  const since = newest
    ? new Date(newest.occurredAt.getTime() - 60 * 60_000)
    : new Date(Date.now() - 30 * 24 * 60 * 60_000)

  let events: Awaited<ReturnType<typeof smartLockAdapter.events>>
  try {
    events = await smartLockAdapter.events({ externalId: unit.smartLock.externalId, since })
  } catch (error) {
    console.error(`[self-showing] could not read events for unit ${unitId}`, error)
    return { error: 'The lock did not answer. The log below is what we already had.' }
  }

  // BOTH KINDS OF CODE (R-094's viewers, R-094b's tenants). Without the
  // second map every tenant entry would land as "no code of ours explains
  // this", which is the exact signal a null is meant to carry - and it would
  // fire on the ordinary case of somebody coming home.
  const [accessRefs, tenantRefs] = await Promise.all([
    prisma.showingAccess.findMany({
      where: { smartLockId: unit.smartLock.id },
      select: { id: true, providerRef: true },
    }),
    prisma.tenantLockCode.findMany({
      where: { smartLockId: unit.smartLock.id },
      select: { id: true, providerRef: true },
    }),
  ])
  const byProviderRef = new Map(accessRefs.map((access) => [access.providerRef, access.id]))
  const tenantByProviderRef = new Map(tenantRefs.map((code) => [code.providerRef, code.id]))

  let unexplained = 0
  for (const event of events) {
    const accessId = event.codeProviderRef ? (byProviderRef.get(event.codeProviderRef) ?? null) : null
    const tenantCodeId = event.codeProviderRef
      ? (tenantByProviderRef.get(event.codeProviderRef) ?? null)
      : null
    if (!accessId && !tenantCodeId) unexplained += 1
    await prisma.lockEvent.upsert({
      where: {
        smartLockId_providerRef: {
          smartLockId: unit.smartLock.id,
          providerRef: event.providerRef,
        },
      },
      // NOTHING ON UPDATE. What the device said the first time is what it
      // said; re-syncing must not rewrite history because a provider
      // reworded a label.
      update: {},
      create: {
        smartLockId: unit.smartLock.id,
        showingAccessId: accessId,
        tenantLockCodeId: tenantCodeId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        providerRef: event.providerRef,
        actorLabel: event.actorLabel,
      },
    })
  }

  await audit({
    action: 'showing.lock_events_synced',
    entityType: 'Unit',
    entityId: unitId,
    propertyId: unit.propertyId,
    // How many arrived, and how many no code of ours explains. The second
    // number is the one worth looking at.
    after: { fetched: events.length, unexplained, since: since.toISOString() },
  })

  revalidatePath(`/units/${unitId}`)
  return {
    notice:
      events.length === 0
        ? 'The lock reported nothing new.'
        : `${events.length} ${events.length === 1 ? 'entry' : 'entries'} read from the lock${unexplained > 0 ? `, ${unexplained} of which no code of ours explains` : ''}.`,
  }
}
