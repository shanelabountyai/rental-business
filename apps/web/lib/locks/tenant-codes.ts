import 'server-only'

import { sealSecret } from '@rental/core/auth'
import type { Prisma } from '@rental/db'
import { prisma } from '@rental/db'
import { smartLockAdapter } from '@/lib/locks/provider.ts'
import { revokeAtDevice } from '@/lib/showings/revoke.ts'

// The smart-lock code lifecycle tied to lease state (PROP-03, LEASE-08;
// R-094b).
//
// ==========================================================================
// A PLAIN MODULE, NOT `'use server'`, because the revoking half is called
// from three places that cannot import each other: the staff action, the
// lease status change, and `party-change-apply.ts` (which runs session-less
// from an e-signature completion). Writing it three times is how two of them
// end up not calling the device.
//
// ISSUING IS DELIBERATE, REVOKING IS AUTOMATIC AND UNCONDITIONAL. R-069
// gates handing a code to a tenant on move-in funds clearing and on no hold
// halting access changes, and neither becomes less true because the lock is
// electronic - so `issueTenantLockCodeFor` refuses rather than warns.
// Revocation takes no gate at all, deliberately: R-084's rule, that gating
// the safe direction is how the safe direction stops being taken, and the
// failure mode of a missed revoke here is a former occupant who can still
// walk in.
// ==========================================================================

const ACCESS_CODE_PURPOSE = 'access-code'

export type IssueRefusal =
  | 'no_smart_lock'
  | 'not_on_this_tenancy'
  | 'already_holds_one'
  | 'device_refused'

export const ISSUE_REFUSAL_MESSAGES: Record<IssueRefusal, string> = {
  no_smart_lock:
    'This unit has no smart lock on file, so there is no door for this system to program. Hand over the keys or the lockbox code from the unit’s own access codes instead — that records a handover, and it does not change any lock.',
  not_on_this_tenancy: 'That person is not on this tenancy.',
  already_holds_one:
    'They already hold a live code for this tenancy. Revoke that one first if it needs replacing — two live codes for one person is two things to revoke when one of them has to go.',
  device_refused:
    'The lock did not answer, so no code was created. Nothing has changed at the door. Try again in a moment.',
}

export interface IssuedTenantCode {
  id: string
  code: string
}

/**
 * Mints one tenant's own code at the device.
 *
 * THE CODE IS RETURNED, NEVER RE-READABLE FROM HERE afterwards by anything
 * but `accesscode.reveal` - the same posture R-069 takes for a static code,
 * and the reason its own action deliberately skips `revalidatePath` (see
 * that file's comment on the Server Action refresh trap).
 */
export async function issueTenantLockCodeFor(input: {
  leaseId: string
  tenantId: string
  staffId: string
}): Promise<{ refusal: IssueRefusal } | { refusal?: undefined; issued: IssuedTenantCode }> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: input.leaseId },
    select: {
      id: true,
      unitId: true,
      leaseTenants: { where: { tenantId: input.tenantId }, select: { id: true } },
      unit: { select: { smartLock: true } },
    },
  })
  const lock = lease.unit.smartLock
  if (!lock || !lock.active) return { refusal: 'no_smart_lock' }
  if (lease.leaseTenants.length === 0) return { refusal: 'not_on_this_tenancy' }

  // Checked here as well as by the partial unique index, because a 23505 is
  // a 500 rather than a sentence somebody can act on.
  const live = await prisma.tenantLockCode.findFirst({
    where: { leaseId: input.leaseId, tenantId: input.tenantId, revokedAt: null },
    select: { id: true },
  })
  if (live) return { refusal: 'already_holds_one' }

  let minted: Awaited<ReturnType<typeof smartLockAdapter.issueCode>>
  try {
    minted = await smartLockAdapter.issueCode({
      externalId: lock.externalId,
      validFrom: new Date(),
      // OPEN-ENDED. See the schema's own comment: a tenant code with an end
      // date is a paying tenant locked out of their home at midnight.
      validTo: null,
      // A label, not a name - it goes into a third party's log with its own
      // readers and its own retention, and the ids here are enough to match
      // it back. The same call R-094 makes for a viewer.
      label: `Tenancy ${input.leaseId.slice(-6)} · ${input.tenantId.slice(-6)}`,
    })
  } catch (error) {
    console.error(`[tenant-codes] lock refused a code for lease ${input.leaseId}`, error)
    // NO ROW. A record of a code the door has never heard of is worse than
    // no record: somebody would hand those digits to a tenant.
    return { refusal: 'device_refused' }
  }

  const row = await prisma.tenantLockCode.create({
    data: {
      smartLockId: lock.id,
      leaseId: input.leaseId,
      tenantId: input.tenantId,
      providerRef: minted.providerRef,
      sealedCode: sealSecret(minted.code, ACCESS_CODE_PURPOSE),
      issuedByStaffId: input.staffId,
    },
    select: { id: true },
  })
  return { issued: { id: row.id, code: minted.code } }
}

export interface RevokedTenantCode {
  id: string
  tenantId: string
  reachedDevice: boolean
}

/**
 * Revokes every live tenant code matching a filter, at the device.
 *
 * TAKES A FILTER RATHER THAN AN ID because every automatic caller is
 * plural: a tenancy ending revokes the whole household's, a party change
 * revokes one leaver's, and a staff member revokes one person's. One
 * function means the device call, the honesty flag and the reason are
 * written once.
 *
 * NEVER THROWS INTO ITS CALLER. A tenancy that could not end because a lock
 * was offline would be the wrong failure; the row records that the door may
 * not agree, and the panel says so in red for as long as it is true.
 */
export async function revokeTenantLockCodes(
  where: { leaseId: string; tenantId?: string },
  input: { reason: string; staffId: string | null },
  tx?: Prisma.TransactionClient,
): Promise<RevokedTenantCode[]> {
  const client = tx ?? prisma
  const live = await client.tenantLockCode.findMany({
    where: { ...where, revokedAt: null },
    include: { smartLock: { select: { externalId: true } } },
  })

  const revoked: RevokedTenantCode[] = []
  for (const code of live) {
    const reachedDevice = await revokeAtDevice({
      externalId: code.smartLock.externalId,
      providerRef: code.providerRef,
      what: `tenant code ${code.id}`,
    })
    await client.tenantLockCode.update({
      where: { id: code.id },
      data: {
        revokedAt: new Date(),
        revokedReason: input.reason,
        revokedByStaffId: input.staffId,
        revokeReachedDevice: reachedDevice,
      },
    })
    revoked.push({ id: code.id, tenantId: code.tenantId, reachedDevice })
  }
  return revoked
}
