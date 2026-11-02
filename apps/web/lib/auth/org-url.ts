import 'server-only'

import { prisma } from '@rental/db'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'

/// Builds an absolute URL on the ORG's host (R-289, R-276, PRD 10 §4): the
/// org's verified custom domain when it has one, else AUTH_URL for org #0 and
/// `<slug>.<ORG_BASE_DOMAIN>` for every other org, keeping AUTH_URL's protocol
/// and port so `*.localhost:3100` works locally. The org comes from the row the
/// link is about, never from the request's Host header: an attacker who can set
/// Host could otherwise have a password-reset link built against their own
/// domain and mailed to the real user. A link on the wrong org's host fails
/// closed (D-344), so the caller MUST name the org.
export async function authUrl(orgId: string, path: string): Promise<string> {
  const base = process.env.AUTH_URL
  if (!base) {
    throw new Error('AUTH_URL is not set; auth links cannot be built.')
  }
  const url = new URL(path, base)
  const root = process.env.ORG_BASE_DOMAIN?.trim().toLowerCase()
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { slug: true, customDomain: true },
  })
  if (org?.customDomain) url.hostname = org.customDomain
  else if (root && orgId !== DEFAULT_ORG_ID) {
    if (!org) throw new Error(`Organisation ${orgId} does not exist; its link cannot be built.`)
    url.hostname = `${org.slug}.${root}`
  }
  return url.toString()
}

/// The URL a provider signed when it posted to `request` (Twilio, R-276): the
/// path it posted to on the host WE registered for the org, which is
/// `authUrl`'s. Never the request's own Host, which behind a proxy is the
/// internal address and in front of one is the caller's to choose.
export async function signedWebhookUrl(request: Request, orgId: string): Promise<string> {
  if (!process.env.AUTH_URL) return request.url
  const incoming = new URL(request.url)
  return authUrl(orgId, incoming.pathname + incoming.search)
}
