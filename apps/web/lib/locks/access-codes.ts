import 'server-only'

import type { Prisma } from '@rental/db'

// The static, unit-scoped codes (`AccessCode`, R-005/R-014): keypad
// combinations, lockbox codes, gate codes. NOT `TenantLockCode` - that is a
// real smart-lock credential and `tenant-codes.ts` next door revokes it at
// the device. Retiring one of these closes OUR RECORD of the code and
// changes no physical lock, which is why every caller that retires them
// also orders somebody out to re-key.

/**
 * Ends every code still open-ended on a unit.
 *
 * `effectiveTo` is R-005's own retirement mechanism (see `addAccessCode`),
 * reused rather than a second notion of "retired" - every reader in this
 * codebase already filters `effectiveTo: null`, so a code with an end date
 * is invisible to the vendor reveal, the tenant issue, the operational
 * panel and the property handoff packet alike.
 *
 * Returns how many were retired, which is what the callers audit: how many,
 * never which (D-107).
 */
export async function retireUnitAccessCodes(
  tx: Prisma.TransactionClient,
  unitId: string,
  at: Date = new Date(),
): Promise<number> {
  const { count } = await tx.accessCode.updateMany({
    where: { unitId, effectiveTo: null },
    data: { effectiveTo: at },
  })
  return count
}
