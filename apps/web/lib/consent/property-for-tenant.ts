import 'server-only'

import { prisma } from '@rental/db'

// NOT a 'use server' module, on purpose (SEC-01): an unguarded export there
// would answer "which property does tenant X lease at" to anybody.

/// The property a tenant's consent is authorised against: any property they
/// hold a lease at. A tenant with no lease at all has no property to scope
/// the check to, so there is nobody who may edit them - which is the correct
/// refusal rather than an oversight.
///
/// Exported: the same derivation authorizes the staff-side notification
/// mirror in lib/notifications/actions.ts. "Consent" in this file's name is
/// history, not scope - this helper answers "which property may staff edit
/// this tenant through", which is the same question for either table.
export async function propertyForTenant(tenantId: string) {
  const leaseTenant = await prisma.leaseTenant.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: { leaseId: true, lease: { select: { property: true } } },
  })
  return leaseTenant ? { property: leaseTenant.lease.property, leaseId: leaseTenant.leaseId } : null
}
