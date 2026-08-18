import 'server-only'

import { checkToken, hashToken } from '@rental/core/auth'
import { type Prospect, prisma } from '@rental/db'

// Reading a PROSPECT_PRESCREEN link (LEASE-07, R-058) - the non-consuming
// half, same split apps/web/lib/portal/verify-link.ts's `verifyVerifyLink()`
// uses: a GET renders the form and must not burn the token merely by being
// opened, so the page and the answer action both call this, and only the
// answer action (prescreen-actions.ts) goes on to redeem it.

export type PrescreenLinkResult =
  | { ok: true; prospect: Prospect }
  | { ok: false; reason: string }

export async function prescreenLinkStatus(rawToken: string): Promise<PrescreenLinkResult> {
  const tokenHash = hashToken(rawToken)
  const stored = await prisma.authToken.findUnique({ where: { tokenHash } })

  const verdict = checkToken(stored, { purpose: 'PROSPECT_PRESCREEN', subjectType: 'Prospect' })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const prospect = await prisma.prospect.findUnique({ where: { id: stored!.subjectId } })
  if (!prospect) return { ok: false, reason: 'not_found' }
  // Already answered is a business fact, not a token defect - the token
  // itself is about to be burned by the action that got them here the
  // first time, but a reload or a second tap of the same link before that
  // commits must not offer the form twice.
  if (prospect.preScreenRespondedAt) return { ok: false, reason: 'already_answered' }

  return { ok: true, prospect }
}
