import 'server-only'

import { prisma } from '@rental/db'

// Reads for one tenancy's door codes (PROP-03, LEASE-08; R-094b). Called
// only after the caller has checked `lease.read` against the lease's own
// property, the same convention every other lease-page query follows.

export async function doorCodesForLease(leaseId: string, unitId: string) {
  const [lock, codes] = await Promise.all([
    prisma.smartLock.findUnique({ where: { unitId }, select: { id: true, active: true } }),
    // Live first, then most recently revoked. A revoked row is kept and read
    // because `revokeReachedDevice: false` is the one thing on this panel
    // that asks somebody to drive to the property, and it has to still be
    // there tomorrow.
    prisma.tenantLockCode.findMany({
      where: { leaseId },
      orderBy: [{ revokedAt: 'desc' }, { issuedAt: 'desc' }],
      include: { issuedBy: { select: { name: true } } },
    }),
  ])
  return { hasSmartLock: lock?.active === true, codes }
}
