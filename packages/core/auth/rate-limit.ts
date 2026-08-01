// Rate limiting and account lockout, as pure decisions. The caller owns the
// storage - it reads the counter, calls in here, and writes the result back -
// which is what keeps this testable without a clock or a database, and what
// makes swapping the DB counter for Redis later a change in one adapter
// rather than in the policy.
//
// Two independent controls, because they stop different attacks:
//
//   Per-IP limiting stops one source spraying many accounts. It cannot stop a
//   botnet, and it must never lock out an account, or an attacker could
//   deny a real tenant access by failing their login on purpose.
//
//   Per-account lockout stops many sources grinding one account. It backs off
//   exponentially rather than locking permanently, because a permanent lock IS
//   the denial-of-service an attacker wanted.

export interface Window {
  windowStartedAt: Date
  count: number
}

export interface RateLimitPolicy {
  /// Requests allowed per window.
  limit: number
  windowMs: number
}

/// Login is the expensive, security-critical endpoint; the others exist so
/// token issuance cannot be used as a free email/SMS cannon once R-030 wires
/// up real delivery.
export const RATE_LIMITS = {
  /// Per IP. Generous enough for a shared office NAT, tight enough that
  /// spraying a password list from one host stalls quickly.
  login: { limit: 10, windowMs: 5 * 60_000 },
  /// Per IP. Requesting magic links is unauthenticated and sends messages.
  magicLinkRequest: { limit: 5, windowMs: 15 * 60_000 },
  passwordResetRequest: { limit: 5, windowMs: 15 * 60_000 },
  /// Per session. A six-digit code is 10^6 wide; without this, an attacker
  /// holding a valid password could simply enumerate it.
  mfaVerify: { limit: 8, windowMs: 5 * 60_000 },
} as const satisfies Record<string, RateLimitPolicy>

export type RateLimitName = keyof typeof RATE_LIMITS

export interface RateLimitDecision {
  allowed: boolean
  /// The counter state to persist. Always present, so the caller has one
  /// write path rather than a branch.
  next: Window
  remaining: number
  retryAfterMs: number
}

export function checkRateLimit(
  policy: RateLimitPolicy,
  current: Window | null,
  now = new Date(),
): RateLimitDecision {
  const windowExpired =
    !current ||
    now.getTime() - current.windowStartedAt.getTime() >= policy.windowMs

  // A fresh window starts at this attempt rather than at the previous
  // window's edge, which is what makes this a fixed window and not a rolling
  // one. Documented in the schema as a deliberate ceiling.
  if (windowExpired) {
    return {
      allowed: true,
      next: { windowStartedAt: now, count: 1 },
      remaining: policy.limit - 1,
      retryAfterMs: 0,
    }
  }

  const elapsed = now.getTime() - current.windowStartedAt.getTime()
  const retryAfterMs = policy.windowMs - elapsed

  if (current.count >= policy.limit) {
    // The count still increments while blocked. Sustained hammering therefore
    // does not reset anything, and the counter doubles as an abuse signal.
    return {
      allowed: false,
      next: { ...current, count: current.count + 1 },
      remaining: 0,
      retryAfterMs,
    }
  }

  return {
    allowed: true,
    next: { ...current, count: current.count + 1 },
    remaining: policy.limit - current.count - 1,
    retryAfterMs: 0,
  }
}

/// Failures tolerated before the first lock. Below this a fat-fingered
/// password costs nothing.
export const LOCKOUT_THRESHOLD = 5
const LOCKOUT_BASE_MS = 60_000
const LOCKOUT_MAX_MS = 60 * 60_000

/**
 * Exponential backoff from the threshold: 1, 2, 4, 8... minutes, capped at an
 * hour. Capped rather than unbounded on purpose - an attacker who can lock an
 * account forever by guessing wrong has a denial-of-service, not a defence.
 * The real owner waits an hour at worst, and password reset stays available
 * throughout.
 */
export function lockoutUntil(
  failedCount: number,
  now = new Date(),
): Date | null {
  if (failedCount < LOCKOUT_THRESHOLD) return null
  const steps = failedCount - LOCKOUT_THRESHOLD
  const delay = Math.min(LOCKOUT_BASE_MS * 2 ** steps, LOCKOUT_MAX_MS)
  return new Date(now.getTime() + delay)
}

export function isLockedOut(
  lockedUntil: Date | null | undefined,
  now = new Date(),
): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime()
}
