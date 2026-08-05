import 'server-only'

import type { TenantScope } from '@rental/core/portal'
import { prisma } from '@rental/db'
import { redirect } from 'next/navigation'
import { auth } from '@/auth.ts'

// The tenant portal's authorization boundary (R-018).
//
// Deliberately its own guard rather than a branch inside lib/auth/guard.ts.
// Staff authorization is RBAC over property scope (R-004); a tenant's is
// "these are my own records" and has no roles, no permissions and no property
// scope at all. Folding the two into one function would mean every call site
// carries a conditional about which kind of principal it is holding, and the
// day somebody gets that conditional backwards is the day a tenant is
// authorized by a staff code path.

/**
 * The signed-in tenant, or a redirect to sign in.
 *
 * `kind !== 'tenant'` is refused rather than upgraded. A STAFF session
 * reaching a portal route is not a tenant and must not be treated as one -
 * there is no tenantId to scope by, and defaulting to "show everything" for a
 * privileged principal is how a debugging convenience becomes a data leak. A
 * staff member who needs to see what a tenant sees gets an impersonation
 * feature, deliberately, with an audit entry - not an accident of this check.
 */
export async function requireTenant(): Promise<{
  id: string
  name: string
  email: string | null
}> {
  const session = await auth()
  const principal = session?.principal

  if (!principal || principal.kind !== 'tenant') {
    redirect('/portal/login')
  }

  return {
    id: principal.id,
    name: principal.name,
    email: principal.email,
  }
}

/**
 * The tenancies this tenant is party to.
 *
 * EVERY lease they have ever been on, live or ended - see TenantScope's own
 * comment. A former tenant chasing a deposit needs their lease and its
 * disposition paperwork, and that is precisely when they are no longer
 * current. Access is by "was party to", not "is currently paying rent".
 *
 * The session itself is the thing that expires: auth.ts refuses to issue or
 * keep one for an inactive Tenant, so a genuinely departed tenant cannot sign
 * in regardless of what this returns.
 */
export async function tenantScope(tenantId: string): Promise<TenantScope> {
  const leaseTenants = await prisma.leaseTenant.findMany({
    where: { tenantId },
    select: { leaseId: true },
  })
  return {
    tenantId,
    leaseIds: leaseTenants.map((row) => row.leaseId),
  }
}

/// Both at once, for the common case of a page that needs the person and
/// their scope. Separate functions above so a caller that genuinely needs
/// only one is not made to pay for a query it will not read.
export async function requireTenantWithScope() {
  const tenant = await requireTenant()
  const scope = await tenantScope(tenant.id)
  return { tenant, scope }
}
