import { prisma } from '@rental/db'

// Reading the TCPA consent trail for one lease (COMM-02, R-051b, wired R-143).
//
// SCOPED BY TENANT, NOT BY LEASE. `TenantConsent` hangs off the tenant, and
// deliberately: an agreement to be texted is a fact about the person, not
// about a tenancy, and it has to survive them moving between units. So this
// reads every consent the lease's tenants hold, including ones recorded while
// they were on a different lease - which is what the send path reads too, and
// the panel would be lying if it showed a narrower set.

export async function consentsForLease(leaseId: string) {
  const tenantIds = (
    await prisma.leaseTenant.findMany({ where: { leaseId }, select: { tenantId: true } })
  ).map((lt) => lt.tenantId)
  if (tenantIds.length === 0) return []

  return prisma.tenantConsent.findMany({
    where: { tenantId: { in: tenantIds } },
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
      recordedBy: { select: { name: true } },
    },
  })
}
