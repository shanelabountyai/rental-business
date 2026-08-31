import 'server-only'

import {
  type TokenPurpose,
  checkRateLimit,
  checkToken,
  hashToken,
  mintToken,
} from '@rental/core/auth'
import { type AuthTokenPurpose, type Prisma, prisma } from '@rental/db'

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
  const stored = await prisma.authToken.findUnique({ where: { tokenHash } })

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
