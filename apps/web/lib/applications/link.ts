import 'server-only'

import { checkToken, hashToken } from '@rental/core/auth'
import { type Applicant, type Application, prisma } from '@rental/db'

// Reading an APPLICATION_LINK (LEASE-03, R-059).
//
// UNLIKE prescreenLinkStatus, this does NOT reject once the applicant is
// done - APPLICATION_LINK is multi-use until it expires (schema's own
// comment on the purpose), by design: an applicant comes back to check fee
// status, review what they submitted, or add a document after their
// household is otherwise complete. The PAGE decides what to render from
// `applicant.formSubmittedAt`/`feePaidAt`/`completedAt`; this function only
// answers "is the link itself still good".

export type ApplicationLinkResult =
  | { ok: true; applicant: Applicant; application: Application }
  | { ok: false; reason: string }

export async function applicationLinkStatus(rawToken: string): Promise<ApplicationLinkResult> {
  const tokenHash = hashToken(rawToken)
  const stored = await prisma.authToken.findUnique({ where: { tokenHash } })

  const verdict = checkToken(stored, { purpose: 'APPLICATION_LINK', subjectType: 'Applicant' })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const applicant = await prisma.applicant.findUnique({ where: { id: stored!.subjectId } })
  if (!applicant) return { ok: false, reason: 'not_found' }
  const application = await prisma.application.findUnique({
    where: { id: applicant.applicationId },
  })
  if (!application) return { ok: false, reason: 'not_found' }

  return { ok: true, applicant, application }
}
