import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Single-use tokens for tenant magic links, password resets and vendor
// work-order links (D-6). Two rules hold for all of them:
//
//   1. The database stores a SHA-256 of the token, never the token. A dump of
//      AuthToken yields nothing anyone can click.
//   2. Lookup is by hash, so verification is a single indexed equality rather
//      than a scan-and-compare - which is also what keeps it constant-time
//      with respect to the stored value.
//
// A plain SHA-256 is correct here and bcrypt/scrypt would be wrong: these are
// 256-bit random values, not user-chosen secrets, so there is no dictionary to
// slow down and no reason to pay a memory-hard cost on every link click.

/// 32 bytes of CSPRNG output, base64url encoded. Comfortably beyond brute
/// force, and short enough to survive an SMS without wrapping badly.
const TOKEN_BYTES = 32

export interface MintedToken {
  /// Goes in the URL. Never persisted, never logged.
  token: string
  /// Goes in the database.
  tokenHash: string
  expiresAt: Date
}

/// §6.1: "tenant/vendor magic links short-lived and single-use". These are the
/// short-lived half; `consumedAt` in the database is the single-use half.
export const TOKEN_TTL_MINUTES = {
  TENANT_MAGIC_LINK: 15,
  STAFF_PASSWORD_RESET: 30,
  TENANT_PASSWORD_RESET: 30,
  /// Long enough to fetch a phone from another room, short enough that a
  /// stolen challenge is worthless by the time anyone notices it.
  STAFF_MFA_CHALLENGE: 5,
  /// Longer because a vendor may not look at their phone for hours, and an
  /// expired dispatch link means a phone call instead of a plumber. Still far
  /// short of the work order's own lifetime - R-025 reissues rather than
  /// stretching this.
  VENDOR_WORK_ORDER: 60 * 24 * 3,
} as const

export type TokenPurpose = keyof typeof TOKEN_TTL_MINUTES

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export function mintToken(purpose: TokenPurpose, now = new Date()): MintedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MINUTES[purpose] * 60_000),
  }
}

export type TokenRejection =
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'wrong_purpose'
  | 'wrong_subject'

/// The stored shape this module needs to make a decision. Kept structural so
/// core does not import Prisma's generated types.
export interface StoredToken {
  purpose: string
  subjectType: string
  subjectId: string
  expiresAt: Date
  consumedAt: Date | null
}

/**
 * Decides whether a stored token may be redeemed. Pure, so the whole decision
 * table is testable without a database - the caller does the lookup by hash
 * and the conditional "consume" update.
 *
 * Order matters: purpose and subject are checked before expiry so a token
 * being replayed against the wrong endpoint reports the real reason to the
 * audit log rather than a misleading "expired".
 */
export function checkToken(
  stored: StoredToken | null,
  expected: { purpose: TokenPurpose; subjectType?: string; subjectId?: string },
  now = new Date(),
): { ok: true } | { ok: false; reason: TokenRejection } {
  if (!stored) return { ok: false, reason: 'not_found' }
  if (stored.purpose !== expected.purpose) {
    return { ok: false, reason: 'wrong_purpose' }
  }
  if (expected.subjectType && stored.subjectType !== expected.subjectType) {
    return { ok: false, reason: 'wrong_subject' }
  }
  if (expected.subjectId && stored.subjectId !== expected.subjectId) {
    return { ok: false, reason: 'wrong_subject' }
  }
  if (stored.consumedAt !== null) return { ok: false, reason: 'already_used' }
  if (stored.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true }
}

/// Recovery codes for the case ROLE-05 does not mention but every MFA rollout
/// hits: the phone is gone. Generated once at enrolment, shown once, stored
/// only as hashes.
export function mintRecoveryCodes(count = 10): {
  codes: string[]
  hashes: string[]
} {
  const codes = Array.from({ length: count }, () =>
    // 10 hex chars, grouped, so it is readable off a piece of paper.
    randomBytes(5).toString('hex').replace(/(.{5})(.{5})/, '$1-$2'),
  )
  return { codes, hashes: codes.map(hashToken) }
}

/**
 * Constant-time membership test for a recovery code. Returns the matched hash
 * so the caller can remove exactly that one - a spent recovery code must not
 * work twice.
 */
export function matchRecoveryCode(
  code: string,
  storedHashes: readonly string[],
): string | null {
  const candidate = Buffer.from(hashToken(code.trim().toLowerCase()))
  let matched: string | null = null

  // Every element is compared even after a hit, so the time taken does not
  // reveal the position of the matching code.
  for (const stored of storedHashes) {
    const storedBuffer = Buffer.from(stored)
    if (
      storedBuffer.length === candidate.length &&
      timingSafeEqual(storedBuffer, candidate)
    ) {
      matched = stored
    }
  }

  return matched
}
