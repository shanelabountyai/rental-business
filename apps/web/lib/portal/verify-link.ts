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
        /// WHAT WAS ACTUALLY DONE, and when, and by whom (R-141). The page
        /// asked "was this fixed?" over the tenant's own three-day-old
        /// report and nothing else - so somebody answering on Thursday about
        /// a Monday leak had to remember, unprompted, which visit this was.
        /// All three are already on the work order; none is new state.
        completedAt: Date | null
        /// Null for an in-house job - the page says "our maintenance team"
        /// rather than naming nobody.
        vendorName: string | null
        /// The property's own zone, because a completion time printed in
        /// UTC is a time in no particular place (R-052).
        timezone: string
        /// The completion photos, which MAINT-06 makes mandatory before a job
        /// can reach WORK_COMPLETE at all — so a tenant on this page is
        /// guaranteed at least one (R-142). Ids only; the bytes go out
        /// through `verify/[token]/photos/[documentId]`, which re-checks the
        /// token rather than trusting that this page rendered the link.
        photoIds: string[]
      }
    }
  | {
      ok: false
      reason: 'invalid' | 'expired' | 'answered' | 'stale_round' | 'not_pending'
      /// What they actually said, when the reason is `answered`.
      ///
      /// Carried because a server action RE-RENDERS the page it was called
      /// from, so the client-side success notice is unmounted before anybody
      /// reads it — the tenant taps "yes" and the next thing they see is this
      /// branch. Without the answer here it could only say "already
      /// answered", which reads like they did something twice. With it, the
      /// record itself is the confirmation, and it is equally right for
      /// somebody returning to the link a day later.
      answer?: { resolved: boolean }
    }

/**
 * Verifies a token from a URL and returns the question it authorizes.
 *
 * NON-CONSUMING, like the vendor link (D-16) and for the same reason: the
 * page has to render before the tenant answers, and burning the token on the
 * GET would mean the POST that follows arrives unauthenticated.
 */
export async function verifyVerifyLink(token: string): Promise<VerifyLinkResult> {
  const stored = await prisma.authToken.findFirst({
    // The RAW token is never stored — only its SHA-256 — so a dump of
    // AuthToken yields nothing anyone can click.
    where: { purpose: PURPOSE, tokenHash: hashToken(token) },
  })
  // The EXPECTATION is passed, not just the clock: `checkToken` compares the
  // purpose and refuses a token minted for anything else. Without it a vendor
  // link's raw token would authenticate here — the hashes live in one table.
  const check = checkToken(stored ?? null, { purpose: PURPOSE, subjectType: 'WorkOrder' })
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
      completedAt: true,
      unit: { select: { name: true } },
      property: { select: { name: true, timezone: true } },
      vendor: { select: { name: true } },
      ticket: { select: { tenantId: true, description: true } },
    },
  })
  if (!workOrder) return { ok: false, reason: 'invalid' }

  // The token's tenant must still be the ticket's tenant. Belt and braces
  // against a ticket reassigned between issue and use.
  if (workOrder.ticket?.tenantId !== tenantId) return { ok: false, reason: 'invalid' }

  const round = workOrder.reopenCount + 1
  const tokenRound = metadata.round ?? round

  // ANSWERED IS CHECKED BEFORE STALE, and the order is the whole reason a
  // "no" works at all.
  //
  // Answering "no" REOPENS the job, which increments `reopenCount` — so by
  // the time the server action re-renders this page, the current round has
  // moved on and the tenant's own token is a round behind. Checking
  // staleness first told the person who had just answered that their link
  // was for an older question, which is both wrong and alarming.
  //
  // Looked up against the TOKEN's round rather than the current one: that is
  // the question this link asked, and its answer is what the tenant should
  // be shown.
  const existing = await prisma.workOrderVerification.findFirst({
    where: { workOrderId: workOrder.id, round: tokenRound },
    select: { id: true, resolved: true },
  })
  if (existing) {
    return { ok: false, reason: 'answered', answer: { resolved: existing.resolved } }
  }

  // A token minted for round 1 cannot ANSWER round 2. Without this, a tenant
  // who kept the old text could reopen-then-close a job they never saw the
  // second attempt at. Only reachable once the round has moved on with the
  // token's own question left unanswered — which is a genuinely stale link.
  if (tokenRound !== round) return { ok: false, reason: 'stale_round' }

  if (workOrder.status !== 'WORK_COMPLETE') return { ok: false, reason: 'not_pending' }

  // AFTER the status gate, not in the select above: a job that is not
  // pending verification never renders a photo, and this is a second query.
  const photos = await prisma.document.findMany({
    where: { workOrderId: workOrder.id, type: 'COMPLETION_PHOTO', deletedAt: null },
    orderBy: { capturedAt: 'asc' },
    select: { id: true },
  })

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
      completedAt: workOrder.completedAt,
      vendorName: workOrder.vendor?.name ?? null,
      timezone: workOrder.property.timezone,
      photoIds: photos.map((photo) => photo.id),
    },
  }
}

export const VERIFY_LINK_TTL_MINUTES = TOKEN_TTL_MINUTES[PURPOSE]

/**
 * What a dead link says, in the tenant's words.
 *
 * Here rather than beside the action because a `'use server'` module may
 * export only async functions — a sync helper there would have to return a
 * Promise, and the first version did exactly that.
 *
 * Every branch names what to do next. A dead end that says only "invalid
 * link" sends somebody to the phone, which is the outcome this whole item
 * exists to remove.
 */
export function rejectionMessage(reason: Extract<VerifyLinkResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'expired':
      return 'This link has expired. If the repair is still not right, message us from your portal or call the office.'
    case 'answered':
      // NOT an error, and the wording has to work for two readers at once:
      // somebody who just tapped (the action re-rendered the page under them)
      // and somebody returning days later. `answeredMessage` below says what
      // they actually told us, which is right for both.
      return 'Thanks — we have your answer on this one.'
    case 'stale_round':
      return 'We asked about this repair again after it was reopened. Please use the most recent message we sent you.'
    case 'not_pending':
      return 'There is nothing to confirm on this repair right now.'
    default:
      return 'This link is not working. Please message us from your portal or call the office.'
  }
}

/**
 * What the tenant told us, said back to them.
 *
 * The confirmation a tenant sees after tapping, because the client-side
 * notice does not survive the re-render a server action triggers. It doubles
 * as the answer for somebody reopening the link later, which is why it states
 * the answer rather than thanking them for a tap that may have been days ago.
 */
export function answeredMessage(resolved: boolean): string {
  return resolved
    ? 'You told us it was fixed, so we have closed it off. If it comes back, report it again and we will reopen it.'
    : 'You told us it is still a problem, so we have reopened it. You do not need to report it again.'
}
