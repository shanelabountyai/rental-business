import 'server-only'

import { prisma } from '@rental/db'
import { redirect } from 'next/navigation'
import { auth } from '@/auth.ts'

// The guarantor portal's authorization boundary (R-165).
//
// Its own file, deliberately - same reasoning as lib/portal/guard.ts
// splitting tenant off from staff. A guarantor is not a tenant: LEASE-06's
// whole point is that they get a financial-only slice ("what they owe"), and
// a guarantor session must never be treated as a tenant session or vice
// versa. Folding this into guard.ts would put a `kind` branch in front of
// every tenant page for a principal that page must never actually serve.

/**
 * The signed-in guarantor, or a redirect to sign in.
 *
 * `kind !== 'guarantor'` is refused rather than upgraded, same rule as
 * `requireTenant` - a STAFF or TENANT session reaching this portal is not a
 * guarantor and must not be treated as one.
 */
export async function requireGuarantor(): Promise<{
  id: string
  name: string
  email: string | null
}> {
  const session = await auth()
  const principal = session?.principal

  if (!principal || principal.kind !== 'guarantor') {
    redirect('/portal/guarantor/login')
  }

  return {
    id: principal.id,
    name: principal.name,
    email: principal.email,
  }
}

/// A guarantor guarantees exactly one lease (Guarantor.leaseId), so there is
/// no join table to query here - the id on the session IS the scope.
export async function requireGuarantorWithScope() {
  const guarantor = await requireGuarantor()
  const record = await prisma.guarantor.findUniqueOrThrow({
    where: { id: guarantor.id },
    select: { leaseId: true },
  })
  return { guarantor, leaseId: record.leaseId }
}
