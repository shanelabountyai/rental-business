import { prisma } from '@rental/db'
import { headers } from 'next/headers'
import { isPlatformHost } from './platform-host.ts'

// Which organisation a request is for, and whether a signed-in principal still
// belongs to it (R-288, PRD 10 §1.4).
//
// THE ORG COMES FROM THE HOST, NEVER FROM A COOKIE OR A FORM. A link pasted
// into a ticket carries its host, so it cannot open a different org than the
// one it names; a cookie would let one tab's choice leak into another's.
//
// `<slug>.<ORG_BASE_DOMAIN>` is that org. Any host NOT under the base is
// org #0 - today's single deployment, `rent.labintelligence.co`, localhost,
// Vercel previews and the e2e suite - which is why nothing changes until
// ORG_BASE_DOMAIN is set (D-324: the domain is not bought yet). The bare base
// host and an unknown slug are NO org, and every sign-in there fails exactly
// like a wrong password.
//
// ponytail: org #0 as the fallback for every unrecognised host. R-289 gives
// the bare base the platform landing page and decides whether a stray host
// should still mean org #0; until org #1 exists (R-291) nothing else could.

export const DEFAULT_ORG_ID = 'org_0'

/// `undefined` = not under the base (org #0); `null` = under it but names no
/// single org; a string = the slug to look up.
export function orgSlugFromHost(
  host: string | null,
  base: string | undefined = process.env.ORG_BASE_DOMAIN,
): string | null | undefined {
  const name = (host ?? '').split(':')[0].trim().toLowerCase()
  const root = base?.trim().toLowerCase()
  if (!root || !name.endsWith(`.${root}`)) return name === root && root ? null : undefined
  const slug = name.slice(0, -root.length - 1)
  return /^[a-z0-9-]+$/.test(slug) ? slug : null
}

/// The org this request's host names, or null for none.
export async function hostOrgId(): Promise<string | null> {
  const host = (await headers()).get('host')
  // The console's host is no org (PRD 11 §2.2), even in dev where it is not
  // under ORG_BASE_DOMAIN and would otherwise fall through to org #0.
  if (isPlatformHost(host)) return null
  const slug = orgSlugFromHost(host)
  if (slug === undefined) return DEFAULT_ORG_ID
  if (slug === null) return null
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } })
  return org?.id ?? null
}

/**
 * Re-read on EVERY authenticated request (auth.ts's jwt callback). Returning
 * false kills the session, which is what makes ROLE-06's one-minute
 * revocation real - and, since R-288, membership removal too (foundation
 * INV-05): a staff session is valid only while its org membership is live, and
 * only on its own org's host.
 */
export async function principalIsStillValid(
  id: string | undefined,
  kind: 'staff' | 'tenant' | 'guarantor' | undefined,
  authenticatedAt: number | undefined,
  orgId: string | undefined,
): Promise<boolean> {
  // A token minted before R-288 has no org. Failing it costs one sign-in; a
  // guessed org would be a session in an org nobody proved membership of.
  if (!id || !kind || !authenticatedAt || !orgId) return false
  // Cookies are host-only today, so another org's session never arrives here.
  // This is the check that keeps that true if R-289 ever widens the cookie.
  if ((await hostOrgId()) !== orgId) return false

  const select = { active: true, sessionsValidFrom: true, orgId: true } as const
  const record =
    kind === 'staff'
      ? await prisma.staffUser
          .findUnique({
            where: { id },
            select: {
              active: true,
              sessionsValidFrom: true,
              orgMemberships: { where: { orgId, removedAt: null }, select: { orgId: true } },
            },
          })
          .then((row) => row && { ...row, orgId: row.orgMemberships[0]?.orgId })
      : kind === 'guarantor'
        ? await prisma.guarantor.findUnique({ where: { id }, select })
        : await prisma.tenant.findUnique({ where: { id }, select })

  if (!record?.active || record.orgId !== orgId) return false
  // Strictly greater-than: a watermark set in the same millisecond as the
  // sign-in belongs to that sign-in, not to a revocation of it.
  return record.sessionsValidFrom.getTime() <= authenticatedAt
}
