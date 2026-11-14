import 'server-only'

import {
  type TokenPurpose,
  checkRateLimit,
  checkToken,
  hashToken,
  RATE_LIMITS,
  mintToken,
} from '@rental/core/auth'
import { type AuthTokenPurpose, type Prisma, prisma } from '@rental/db'
import { headers } from 'next/headers'

// The database side of the auth primitives. packages/core decides; this file
// reads and writes. Keeping the split means the policy has unit tests with no
// database and the storage has integration tests with no policy.

/**
 * Consumes one unit of a rate-limit budget and reports whether the caller may
 * proceed.
 *
 * Serialized per key by a transaction-scoped advisory lock. `SELECT ... FOR
 * UPDATE` is the obvious choice and is WRONG here: the first request for a
 * given key finds no row, so there is nothing to lock, and every concurrent
 * attempt independently concludes it is opening a fresh window. The limiter
 * then permits all of them - which is precisely the moment it is under attack.
 *
 * An advisory lock takes a lock on the KEY rather than on a row, so it works
 * before the row exists. `_xact_` rather than the session variant because Neon
 * pools connections in transaction mode; a session lock would outlive the
 * request and leak into whoever got the connection next.
 *
 * hashtext collisions merely serialize two unrelated keys for a moment, which
 * costs nothing and cannot let an extra request through.
 *
 * `timeout: 15_000`, above Prisma's 5s default: every concurrent caller for
 * the SAME key queues behind one advisory lock, so the last in line is
 * waiting on everyone ahead of it to finish, not just doing its own work -
 * and that queue wait counts against the interactive-transaction timeout.
 * Found via a burst of 20 concurrent callers in store.test.ts, which is a
 * deliberately adversarial test scenario, not real traffic: no genuine
 * request pattern for a 10-50 unit portal sends 20 simultaneous attempts at
 * the identical rate-limit key. Raising the ceiling only affects how long a
 * request in that rare pile-up waits before giving up; it changes nothing
 * about how quickly an ordinary, uncontended check completes.
 */
export async function consumeRateLimit(
  key: string,
  policy: { limit: number; windowMs: number },
  now = new Date(),
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`

      const rows = await tx.$queryRaw<
        Array<{ windowStartedAt: Date; count: number }>
      >`SELECT "windowStartedAt", "count" FROM "RateLimitCounter" WHERE "key" = ${key}`

      const decision = checkRateLimit(policy, rows[0] ?? null, now)

      await tx.rateLimitCounter.upsert({
        where: { key },
        create: {
          key,
          windowStartedAt: decision.next.windowStartedAt,
          count: decision.next.count,
        },
        update: {
          windowStartedAt: decision.next.windowStartedAt,
          count: decision.next.count,
        },
      })

      return { allowed: decision.allowed, retryAfterMs: decision.retryAfterMs }
    },
    { timeout: 15_000 },
  )
}

/**
 * Whether `key` has already used its whole budget in the current window.
 * Counts nothing - the caller decides what is worth a unit (K5: a token
 * lookup that missed). Same window arithmetic as `checkRateLimit`.
 */
export async function rateLimitSpent(
  key: string,
  policy: { limit: number; windowMs: number },
  now = new Date(),
): Promise<boolean> {
  const row = await prisma.rateLimitCounter.findUnique({ where: { key } })
  if (!row) return false
  if (now.getTime() - row.windowStartedAt.getTime() >= policy.windowMs) return false
  return row.count >= policy.limit
}

// K5 (INV-09): every unauthenticated token lookup goes through here, so a
// stranger guessing link tokens is limited per IP in the shared (Postgres)
// store. Only a MISS - no AuthToken row with that hash - is counted; an
// expired, used or revoked token is a real link, not a guess, and a renter
// reloading their own link never spends anything.
//
// Once an IP is over the budget every lookup from it reads as "no such
// token", which every caller already handles as not-found. Nothing new is
// shown to anybody, and a real link from that IP works again when the window
// ends.
//
// Outside a request (a job, a unit test calling a verifier directly) there is
// no client and nothing is limited. With no `x-forwarded-for` (local dev and
// the e2e server, which sit behind no proxy) it is also skipped: keying every
// such request on one shared "unknown" bucket would let one spec's
// bad-token test lock out the next. Vercel always sets the header.

const TOKEN_MISS_KEY = 'token-miss:'

async function tokenLookupIp(): Promise<string | null> {
  try {
    const forwarded = (await headers()).get('x-forwarded-for')
    return forwarded?.split(',')[0]?.trim() || null
  } catch {
    return null
  }
}

/// Runs one token lookup under the miss limit. `find` returns the row or null;
/// a null is a miss and is counted. Generic so the other token tables
/// (OrgInvite, FinalExport) share the same budget as AuthToken.
export async function withTokenMissLimit<T>(find: () => Promise<T | null>): Promise<T | null> {
  const ip = await tokenLookupIp()
  const key = `${TOKEN_MISS_KEY}${ip}`
  if (ip && (await rateLimitSpent(key, RATE_LIMITS.tokenLookupMiss))) return null
  const found = await find()
  if (!found && ip) await consumeRateLimit(key, RATE_LIMITS.tokenLookupMiss)
  return found
}

export async function lookupAuthToken(where: Prisma.AuthTokenWhereInput) {
  return withTokenMissLimit(() => prisma.authToken.findFirst({ where }))
}

export interface IssuedToken {
  /// The value to put in a link or a cookie. Exists only in memory and in
  /// whatever is delivering it.
  token: string
  expiresAt: Date
  /// The AuthToken row's id - safe to log, store and key on, unlike `token`.
  /// R-139 needs it as the notification's idempotency key: it is the natural
  /// key of "this link was issued", so a retry of the same mint is a
  /// duplicate and a second mint is not.
  id: string
}

export async function issueToken(
  purpose: TokenPurpose & AuthTokenPurpose,
  subject: { type: string; id: string },
  options: { requestedIp?: string; metadata?: Prisma.InputJsonValue } = {},
): Promise<IssuedToken> {
  const minted = mintToken(purpose)
  const row = await prisma.authToken.create({
    data: {
      purpose,
      tokenHash: minted.tokenHash,
      subjectType: subject.type,
      subjectId: subject.id,
      expiresAt: minted.expiresAt,
      requestedIp: options.requestedIp,
      metadata: options.metadata,
    },
  })
  return { token: minted.token, expiresAt: minted.expiresAt, id: row.id }
}

export type RedeemResult =
  | {
      ok: true
      subjectId: string
      metadata: Prisma.JsonValue
      /// Where the token was issued from. Carried through so a sign-in audit
      /// entry can name an address even though the provider that completes the
      /// sign-in has no request to read one from.
      requestedIp: string | null
    }
  | { ok: false; reason: string }

/**
 * Verifies and burns a token in one step.
 *
 * The consuming update is conditional on `consumedAt` still being null and
 * uses the affected-row count to decide the outcome. That is what makes it
 * genuinely single-use: two clicks on the same magic link arriving at the same
 * moment both pass the read, but only one updates a row, and the loser is told
 * the token was already used. Checking and then updating without the condition
 * would let both in.
 */
export async function redeemToken(
  rawToken: string,
  expected: { purpose: TokenPurpose & AuthTokenPurpose; subjectType?: string },
  now = new Date(),
): Promise<RedeemResult> {
  const tokenHash = hashToken(rawToken)
  const stored = await lookupAuthToken({ tokenHash })

  const verdict = checkToken(stored, expected, now)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const burned = await prisma.authToken.updateMany({
    where: { tokenHash, consumedAt: null },
    data: { consumedAt: now },
  })
  if (burned.count !== 1) return { ok: false, reason: 'already_used' }

  return {
    ok: true,
    subjectId: stored!.subjectId,
    metadata: stored!.metadata,
    requestedIp: stored!.requestedIp,
  }
}

/**
 * Invalidates every outstanding token of a purpose for a subject. Called when
 * a password is reset, so the reset link that was just used cannot be joined
 * by a second one sitting in an older email.
 */
export async function revokeTokens(
  purpose: AuthTokenPurpose,
  subjectId: string,
  now = new Date(),
): Promise<number> {
  const { count } = await prisma.authToken.updateMany({
    where: { purpose, subjectId, consumedAt: null },
    data: { consumedAt: now },
  })
  return count
}
