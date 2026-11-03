import 'server-only'

import type { TenantScope } from '@rental/core/portal'
import { openOrgContext, prisma } from '@rental/db'
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
 * privileged principal is how a debugging convenience becomes a data leak.
 * Nobody impersonates a tenant: staff never, and platform support only reads
 * the org's own staff screens under a grant the owners can see (PRD 11 §4.7,
 * R-295b). A support session is not this cookie at all, so it never gets here.
 */
export async function requireTenant(): Promise<{
  id: string
  name: string
  email: string | null
}> {
  // The org as the row-level-security context, opened before the await so
  // the caller sees it (R-287a; see actorInOrg in lib/auth/guard.ts).
  const bind = openOrgContext()
  const session = await auth()
  const principal = session?.principal
  if (principal) bind(principal.orgId)

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
    // unitId as well as leaseId since R-020: the shutoff-photo safety
    // exception is keyed on the unit, because that is where R-014 attaches
    // the photo. See tenantCanSeeDocument for why that exception is one
    // named document type rather than "unit documents".
    select: { leaseId: true, lease: { select: { unitId: true } } },
  })
  return {
    tenantId,
    leaseIds: leaseTenants.map((row) => row.leaseId),
    unitIds: [...new Set(leaseTenants.map((row) => row.lease.unitId))],
  }
}

/// R-300a: the tenant's org is FROZEN or OFFBOARDED. The portal layout reads
/// it for the banner; `requireTenantWithScope({ write: true })` for refusing.
export async function tenantOrgFrozen(tenantId: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { organization: { select: { status: true } } } })
  const status = tenant?.organization.status
  return status === 'FROZEN' || status === 'OFFBOARDED'
}

/// Both at once, for the common case of a page that needs the person and
/// their scope. Separate functions above so a caller that genuinely needs
/// only one is not made to pay for a query it will not read.
///
/// `write: true` on every tenant ACTION (R-300a): a tenant's writes ask for no
/// permission, so the freeze that narrowed them is checked here instead. The
/// portal's banner says why the press went nowhere.
export async function requireTenantWithScope(options: { write?: boolean } = {}) {
  const tenant = await requireTenant()
  if (options.write && (await tenantOrgFrozen(tenant.id))) redirect('/portal')
  const scope = await tenantScope(tenant.id)
  return { tenant, scope }
}
