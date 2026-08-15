import 'server-only'

import { TOKEN_TTL_MINUTES, checkToken, hashToken, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'

// The tenant's one tap, without a login wall (MAINT-07, COMM-02, R-032c).
//
// ==========================================================================
// WHY THIS EXISTS. R-030's verification SMS carried a PORTAL url. That page
// sits behind `requireTenant`, which redirects to `/portal/login` with no
// return-to, and portal login is EMAIL-ONLY — "enter the email address on
// your lease". So for a tenant with a phone and no email, the exact persona
// R-021 was built for, the message asking "was this fixed?" was a dead end.
// For everybody else it was: tap → login wall → leave the thread → find the
// email → tap → portal home → navigate → find the job → answer.
//
// The reply rate is the entire value of the feature. A verification nobody
// can answer is a work order closed on silence, which R-030 permits and
// records as `unverified` — so the cost of this was invisible in the data.
// ==========================================================================
//
// SCOPED TO ONE QUESTION. The token names a work order, a tenant and a
// ROUND. It opens no portal session, reads no document and moves no money;
// the most a leaked one can do is answer a maintenance question wrongly,
// which a PM can see on the timeline and reopen. That narrowness is what
// justifies the seven-day lifetime — see TOKEN_TTL_MINUTES.TENANT_VERIFY.
//
// MULTI-USE UNTIL IT EXPIRES, on D-16's reasoning rather than by copying it:
// a tenant who taps the link, gets distracted and comes back an hour later
// must not find it dead. The answer is once-only regardless, enforced by the
// unique index on (workOrderId, round) — so "multi-use" here means the PAGE
// can be reopened, not that the question can be answered twice.

const PURPOSE = 'TENANT_VERIFY' as const

export interface VerifyLinkSubject {
  workOrderId: string
  tenantId: string
  round: number
}

/**
 * Mints the link that goes in the message.
 *
 * Revokes any earlier live token for the same work order first. A reopened
 * job asks again, and the previous round's link must not still answer the
 * new question — the round is in the metadata and checked on use, but
 * revoking makes the stale link fail as *expired* rather than as a confusing
 * mismatch.
 */
export async function issueVerifyLink(
  subject: VerifyLinkSubject,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const minted = mintToken(PURPOSE, now)

  await prisma.$transaction(async (tx) => {
    await tx.authToken.updateMany({
      where: { purpose: PURPOSE, subjectId: subject.workOrderId, consumedAt: null },
      data: { consumedAt: now },
    })
    await tx.authToken.create({
      data: {
        purpose: PURPOSE,
        tokenHash: minted.tokenHash,
        subjectType: 'WorkOrder',
        subjectId: subject.workOrderId,
        expiresAt: minted.expiresAt,
        // The tenant is in the metadata, not inferred from the work order at
        // use time. A job reassigned to a different unit or ticket must not
        // silently move who is entitled to answer.
        metadata: { tenantId: subject.tenantId, round: subject.round },
      },
    })
  })

  return { token: minted.token, expiresAt: minted.expiresAt }
}

export type VerifyLinkResult =
  | {
      ok: true
      workOrderId: string
      tenantId: string
      round: number
      job: {
        scope: string
        unitName: string
        propertyName: string
        requestSummary: string | null
      }
    }
  | { ok: false; reason: 'invalid' | 'expired' | 'answered' | 'stale_round' | 'not_pending' }

/**
 * Verifies a token from a URL and returns the question it authorizes.
 *
 * NON-CONSUMING, like the vendor link (D-16) and for the same reason: the
 * page has to render before the tenant answers, and burning the token on the
 * GET would mean the POST that follows arrives unauthenticated.
 */
export async function verifyVerifyLink(token: string): Promise<VerifyLinkResult> {
  const stored = await prisma.authToken.findFirst({
    where: { purpose: PURPOSE, tokenHash: hashOf(token) },
  })
  const check = checkToken(stored ?? null, new Date())
  if (!check.ok) {
    return { ok: false, reason: check.reason === 'expired' ? 'expired' : 'invalid' }
  }

  const metadata = (stored!.metadata ?? {}) as { tenantId?: string; round?: number }
  const tenantId = metadata.tenantId
  if (!tenantId) return { ok: false, reason: 'invalid' }

  const workOrder = await prisma.workOrder.findUnique({
    where: { id: stored!.subjectId },
    select: {
      id: true,
      status: true,
      scope: true,
      reopenCount: true,
      unit: { select: { name: true } },
      property: { select: { name: true } },
      ticket: { select: { tenantId: true, description: true } },
    },
  })
  if (!workOrder) return { ok: false, reason: 'invalid' }

  // The token's tenant must still be the ticket's tenant. Belt and braces
  // against a ticket reassigned between issue and use.
  if (workOrder.ticket?.tenantId !== tenantId) return { ok: false, reason: 'invalid' }

  const round = workOrder.reopenCount + 1
  // A token minted for round 1 cannot answer round 2. Without this, a tenant
  // who kept the old text could reopen-then-close a job they never saw the
  // second attempt at.
  if (metadata.round != null && metadata.round !== round) {
    return { ok: false, reason: 'stale_round' }
  }

  // Already answered this round — a distinct outcome from an invalid token,
  // because the page should say "we have your answer" rather than "this link
  // is not working", which would send somebody to the phone.
  const existing = await prisma.workOrderVerification.findFirst({
    where: { workOrderId: workOrder.id, round },
    select: { id: true },
  })
  if (existing) return { ok: false, reason: 'answered' }

  if (workOrder.status !== 'WORK_COMPLETE') return { ok: false, reason: 'not_pending' }

  return {
    ok: true,
    workOrderId: workOrder.id,
    tenantId,
    round,
    job: {
      scope: workOrder.scope,
      unitName: workOrder.unit.name,
      propertyName: workOrder.property.name,
      // The TENANT's words, not the internal scope — the same choice the
      // message itself makes.
      requestSummary: workOrder.ticket?.description?.slice(0, 200) ?? null,
    },
  }
}

/// Re-exported through a named helper so this file does not import the hash
/// directly in two places and drift from `mintToken`'s algorithm.
function hashOf(token: string): string {
  return hashToken(token)
}

import { hashToken } from '@rental/core/auth'

export const VERIFY_LINK_TTL_MINUTES = TOKEN_TTL_MINUTES[PURPOSE]
