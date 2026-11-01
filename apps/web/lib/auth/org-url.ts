import 'server-only'

import { prisma } from '@rental/db'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'

/// Builds an absolute URL on the ORG's host (R-289, PRD 10 §4): AUTH_URL for
/// org #0, `<slug>.<ORG_BASE_DOMAIN>` for every other org, keeping AUTH_URL's
/// protocol and port so `*.localhost:3100` works locally. The org comes from
/// the row the link is about, never from the request's Host header: an
/// attacker who can set Host could otherwise have a password-reset link built
/// against their own domain and mailed to the real user. A link on the wrong
/// org's host fails closed (D-344), so the caller MUST name the org.
export async function authUrl(orgId: string, path: string): Promise<string> {
  const base = process.env.AUTH_URL
  if (!base) {
    throw new Error('AUTH_URL is not set; auth links cannot be built.')
  }
  const url = new URL(path, base)
  const root = process.env.ORG_BASE_DOMAIN?.trim().toLowerCase()
  if (root && orgId !== DEFAULT_ORG_ID) {
    const { slug } = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { slug: true },
    })
    url.hostname = `${slug}.${root}`
  }
  return url.toString()
}
