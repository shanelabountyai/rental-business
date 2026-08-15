import 'server-only'

import { TOKEN_TTL_MINUTES, checkToken, hashToken, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'

// Pay rent from the link in the reminder (PAY-01, COMM-02, R-046).
//
// ==========================================================================
// WHY THIS EXISTS. R-045's rent reminder carries a PORTAL url. That page sits
// behind `requireTenant`, which redirects to `/portal/login` — and portal
// login is EMAIL-ONLY. So for a tenant with a phone and no email (R-021's
// whole persona) the message whose entire purpose is "go and pay" is a dead
// end, and for everyone else it is: tap → login wall → leave the thread →
// find the email → tap → portal home → navigate → pay.
//
// The same dead end R-032c found for the verification message. It costs more
// here, because every step between the tap and the button is somewhere a
// tenant stops, and the thing they stop doing is paying rent.
// ==========================================================================
//
// NO PORTAL SESSION, AND THAT IS THE DESIGN (D-45).
//
// The backlog says "a portal session scoped to paying only". A real session
// carrying a scope marker would mean every one of the portal's
// `requireTenant` call sites had to refuse it, and any one missed would grant
// a leaked pay link the tenant's messages, papers and lease documents —
// fail-OPEN, which is the shape guard.ts's own header warns about.
//
// So this grants a token-scoped PAGE instead, exactly as the vendor link
// (D-6) and the verify link (R-032c) do. There is no session for any other
// route to trust, so nothing else is reachable by construction. What a
// leaked token can do is bounded and stated: see that lease's balance, and
// pay that lease's rent.
//
// SCOPED TO ONE PAYER, not one tenant. A tenant on two tenancies gets a link
// per payer, and the one in the August reminder for unit A cannot pay — or
// display — unit B.
//
// MULTI-USE until it expires, on D-16's reasoning: a tenant who taps, checks
// their bank balance and comes back must not find it dead. Paying twice is
// prevented by the balance itself reaching zero, which `validatePaymentAmount`
// already enforces on the write path — not by burning the token.

const PURPOSE = 'TENANT_PAY_LINK' as const

export const PAY_LINK_TTL_MINUTES = TOKEN_TTL_MINUTES[PURPOSE]

export interface PayLinkSubject {
  leasePayerId: string
  tenantId: string
  leaseId: string
  /// The LOGICAL send this link went out in, when it went out in one —
  /// `NotifyInput.idempotencyKey`, not a row id.
  ///
  /// A row id would be a lie by arbitrary choice: `notify()` fans one
  /// logical notification out to a row PER CHANNEL, so there is no single
  /// Notification this link "was sent in". The engine suffixes the channel
  /// onto this key (see Notification.idempotencyKey), so storing the base
  /// finds every channel's row with a `startsWith` — which is the question
  /// "did the reminder work" actually wants answered, across whichever
  /// channel the tenant happened to tap.
  notificationKey?: string | null
}

/**
 * Mints the link that goes in the message.
 *
 * REVOKES ANY EARLIER LIVE LINK for the same payer, which is what makes
 * "expiry and revocation" real rather than nominal. A tenant who gets a
 * due-soon reminder and then a due-today reminder holds one live link, not
 * two — and the same mechanism lets `revokePayLinks` kill a link outright
 * when a tenancy goes onto a legal-action hold (R-047).
 */
export async function issuePayLink(
  subject: PayLinkSubject,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const minted = mintToken(PURPOSE, now)

  await prisma.$transaction(async (tx) => {
    await tx.authToken.updateMany({
      where: { purpose: PURPOSE, subjectId: subject.leasePayerId, consumedAt: null },
      data: { consumedAt: now },
    })
    await tx.authToken.create({
      data: {
        purpose: PURPOSE,
        tokenHash: minted.tokenHash,
        subjectType: 'LeasePayer',
        subjectId: subject.leasePayerId,
        expiresAt: minted.expiresAt,
        // The tenant and lease are RECORDED, not inferred at use time. A
        // payer row edited between issue and use must not silently move who
        // this link belongs to or which tenancy it pays.
        metadata: {
          tenantId: subject.tenantId,
          leaseId: subject.leaseId,
          notificationKey: subject.notificationKey ?? null,
        },
      },
    })
  })

  return { token: minted.token, expiresAt: minted.expiresAt }
}

/**
 * Kills every live pay link for a payer.
 *
 * The explicit half of "expiry and revocation". Separate from reissuing
 * because the reasons differ: reissuing replaces a link, this one withdraws
 * the ability to pay online at all — which is what a legal-action hold
 * (PAY-12, R-047) needs, and what somebody reporting a forwarded message
 * needs. Returns how many were killed so a caller can say so.
 */
export async function revokePayLinks(leasePayerId: string, now = new Date()): Promise<number> {
  const result = await prisma.authToken.updateMany({
    where: { purpose: PURPOSE, subjectId: leasePayerId, consumedAt: null },
    data: { consumedAt: now },
  })
  return result.count
}

export type PayLinkResult =
  | {
      ok: true
      leasePayerId: string
      tenantId: string
      leaseId: string
      notificationKey: string | null
      tenantFirstName: string
    }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'paused' }

/**
 * Verifies a token from a URL and returns the payer it authorizes.
 *
 * NON-CONSUMING, like the vendor and verify links and for the same reason:
 * the page must render before the tenant pays, so burning the token on the
 * GET would leave the POST that follows unauthenticated.
 */
export async function verifyPayLink(token: string, now = new Date()): Promise<PayLinkResult> {
  const stored = await prisma.authToken.findFirst({
    // The RAW token is never stored — only its SHA-256 — so a dump of
    // AuthToken yields nothing anyone can click.
    where: { purpose: PURPOSE, tokenHash: hashToken(token) },
  })
  // The EXPECTATION is passed, not just the clock: `checkToken` refuses a
  // token minted for any other purpose. Without it a vendor link's raw token
  // would authenticate here — every purpose's hashes live in one table.
  const check = checkToken(stored ?? null, { purpose: PURPOSE, subjectType: 'LeasePayer' }, now)
  if (!check.ok) {
    return {
      ok: false,
      // A revoked link and an expired one are both `already_used` to
      // `checkToken` (both set `consumedAt`), but they are different things
      // to a tenant: one says "ask for a new one", the other says "call us".
      // Distinguished by whether the clock actually ran out.
      reason:
        check.reason === 'expired'
          ? 'expired'
          : check.reason === 'already_used'
            ? stored!.expiresAt.getTime() <= now.getTime()
              ? 'expired'
              : 'revoked'
            : 'invalid',
    }
  }

  const metadata = (stored!.metadata ?? {}) as {
    tenantId?: string
    leaseId?: string
    notificationKey?: string | null
  }
  if (!metadata.tenantId || !metadata.leaseId) return { ok: false, reason: 'invalid' }

  const payer = await prisma.leasePayer.findUnique({
    where: { id: stored!.subjectId },
    select: {
      id: true,
      leaseId: true,
      tenantId: true,
      active: true,
      collectionPaused: true,
      tenant: { select: { firstName: true, active: true } },
    },
  })
  if (!payer || !payer.active || !payer.tenant?.active) return { ok: false, reason: 'invalid' }

  // The token's tenant and lease must still be the payer's. Belt and braces
  // against a payer row edited between issue and use — the same check the
  // verify link makes against a reassigned ticket.
  if (payer.tenantId !== metadata.tenantId || payer.leaseId !== metadata.leaseId) {
    return { ok: false, reason: 'invalid' }
  }

  // PAY-12's legal-action hold. Checked here as well as on the write path,
  // so a held tenancy does not render a payment form it would then refuse —
  // and `startPayment` refuses it again regardless, because a page rendered
  // before the hold was applied is still sitting in somebody's browser.
  if (payer.collectionPaused) return { ok: false, reason: 'paused' }

  return {
    ok: true,
    leasePayerId: payer.id,
    tenantId: payer.tenantId!,
    leaseId: payer.leaseId,
    notificationKey: metadata.notificationKey ?? null,
    tenantFirstName: payer.tenant.firstName,
  }
}

/**
 * What a dead link says, in the tenant's words.
 *
 * Here rather than beside the action because a `'use server'` module may
 * export only async functions. Every branch names what to do next: a dead
 * end that says only "invalid link" sends somebody to the phone, which is
 * the outcome this item exists to remove.
 */
export function payLinkRejection(reason: Extract<PayLinkResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'expired':
      return 'This payment link has expired. Sign in to your portal to pay, or call the office and we will send a new one.'
    case 'revoked':
      return 'This payment link is no longer active. Please sign in to your portal to pay, or call the office.'
    case 'paused':
      // Says nothing about WHY — a legal-action hold is not something a
      // payment screen explains, and R-047 owns the message that does. Same
      // wording as the pay screen's own refusal, deliberately.
      return 'Online payments are not available on this account. Please contact the office.'
    default:
      return 'This payment link is not working. Please sign in to your portal to pay, or call the office.'
  }
}
