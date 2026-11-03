import 'server-only'

import { hashToken } from '@rental/core/auth'
import { prisma } from '@rental/db'

/// Every link the page will not honour - unknown, expired, another host's -
/// reads this one sentence, so none of them tells a guesser which it was.
export const FINAL_EXPORT_REFUSED = 'This link is not valid any more. Final export links work for 7 days after offboarding.'

/// The link a token names, if it is usable on this host now (D-388).
export async function usableFinalExportLink(token: string, hostOrgId: string | null, now = new Date()) {
  if (!token || !hostOrgId) return null
  const link = await prisma.finalExportLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, orgId: true, staffUserId: true, storageKey: true, expiresAt: true, organization: { select: { name: true } } },
  })
  return link && link.orgId === hostOrgId && link.expiresAt > now ? link : null
}
