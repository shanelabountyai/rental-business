import 'server-only'

import type { Prisma } from '@rental/db'
import { prisma } from '@rental/db'
import { smartLockAdapter } from '@/lib/locks/provider.ts'

// Killing an unaccompanied entry code (LEASE-08's "instant kill"; R-094).
//
// ==========================================================================
// THE DEVICE IS WHAT MATTERS. OUR PAGE REFUSING IS ONLY THE SECOND LOCK.
//
// `selfShowingDecision` refuses to display a code for a cancelled showing,
// an occupied unit or a revoked row - but the person may already have the
// digits written on their hand, and the lock has never heard of any of it.
// A kill that only wrote `revokedAt` would leave a working code on a door
// and a product confidently showing "cancelled" on a screen.
//
// So this calls the provider FIRST and writes the row after. If the device
// cannot be reached the row is still written and the caller is told plainly
// that the code may still work - which is the honest answer, and the one
// that sends somebody to the property to change the lock instead of leaving
// them believing it is handled.
// ==========================================================================

/// A plain module, not `'use server'`, because two server actions need it:
/// the explicit kill, and `cancelShowing` - a cancelled showing whose code
/// still opens the door is the failure this whole file exists to prevent,
/// and it was the one that would have shipped.
export interface RevokeOutcome {
  /// False when the provider refused or could not be reached. The row is
  /// written either way; this says whether the door actually changed.
  reachedDevice: boolean
}

export async function revokeShowingAccessFor(
  showingId: string,
  input: { reason: string; staffId: string | null },
  tx?: Prisma.TransactionClient,
): Promise<RevokeOutcome | null> {
  const client = tx ?? prisma
  const access = await client.showingAccess.findUnique({
    where: { showingId },
    include: { smartLock: { select: { externalId: true } } },
  })
  if (!access || access.revokedAt) return null

  let reachedDevice = true
  try {
    // Idempotent by the adapter's contract: an already-revoked code is a
    // success, because the kill must never fail on a second press.
    await smartLockAdapter.revokeCode({
      externalId: access.smartLock.externalId,
      providerRef: access.providerRef,
    })
  } catch (error) {
    console.error(`[self-showing] device refused a revoke for showing ${showingId}`, error)
    reachedDevice = false
  }

  await client.showingAccess.update({
    where: { id: access.id },
    data: {
      revokedAt: new Date(),
      revokedReason: input.reason,
      revokedByStaffId: input.staffId,
      // Written on the ROW, not only returned. The warning that asks
      // somebody to go and change a lock used to live in the action's result
      // and was rendered by the very form a successful revoke unmounts, so
      // it was destroyed by its own re-render every time.
      revokeReachedDevice: reachedDevice,
    },
  })
  return { reachedDevice }
}
