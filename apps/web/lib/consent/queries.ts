import { prisma } from '@rental/db'

// Reading the TCPA consent trail for one lease (COMM-02, R-051b, wired R-143).
//
// SCOPED BY TENANT, NOT BY LEASE. `TenantConsent` hangs off the tenant, and
// deliberately: an agreement to be texted is a fact about the person, not
// about a tenancy, and it has to survive them moving between units. So this
// reads every consent the lease's tenants hold, including ones recorded while
// they were on a different lease - which is what the send path reads too, and
// the panel would be lying if it showed a narrower set.

/// One tenant's own consent trail, for the portal (R-164). Scoped by
/// `tenantId` directly rather than through a lease - see this file's header:
/// `TenantConsent` hangs off the tenant and outlives any one tenancy, so a
/// tenant reading their own record should see all of it, the same as
/// `consentsForLease` shows staff for anyone on the lease.
export async function consentsForTenant(tenantId: string) {
  return prisma.tenantConsent.findMany({
    where: { tenantId },
    orderBy: { recordedAt: 'desc' },
    select: {
      id: true,
      channel: true,
      basis: true,
      disclosureText: true,
      recordedAt: true,
      revokedAt: true,
      revokeReason: true,
    },
  })
}

/// Every tenant's consent trail, and every guarantor's (R-196) - released
/// guarantors included, because what they agreed to while liable is still
/// the record of why they were or were not texted.
export async function consentsForLease(leaseId: string) {
  const [tenantIds, guarantorIds] = await Promise.all([
    prisma.leaseTenant
      .findMany({ where: { leaseId }, select: { tenantId: true } })
      .then((rows) => rows.map((lt) => lt.tenantId)),
    prisma.guarantor
      .findMany({ where: { leaseId }, select: { id: true } })
      .then((rows) => rows.map((g) => g.id)),
  ])
  if (tenantIds.length === 0 && guarantorIds.length === 0) return []

  return prisma.tenantConsent.findMany({
    where: { OR: [{ tenantId: { in: tenantIds } }, { guarantorId: { in: guarantorIds } }] },
    orderBy: { recordedAt: 'desc' },
    select: {
      id: true,
      channel: true,
      basis: true,
      source: true,
      disclosureText: true,
      note: true,
      recordedAt: true,
      revokedAt: true,
      revokeReason: true,
      tenant: { select: { id: true, firstName: true, lastName: true } },
      guarantor: { select: { id: true, firstName: true, lastName: true } },
      recordedBy: { select: { name: true } },
    },
  })
}
