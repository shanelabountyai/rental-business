import {
  type ScryptOptions,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

// promisify picks node:crypto's three-argument scrypt overload, which drops
// the options parameter these cost settings depend on. Naming the signature
// keeps the tuning below type-checked instead of silently ignored.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

// scrypt from node:crypto rather than bcrypt or argon2 from npm. It is a
// memory-hard password hash in the standard library, which means no native
// build step, no supply chain to audit, and no dependency to keep patched on
// the one code path where a compromised package is worst.
//
// Parameters follow OWASP's scrypt guidance: N = 2^17, r = 8, p = 1, which
// costs roughly 128 MB and ~100ms per hash. `maxmem` has to be raised because
// Node's default 32 MB ceiling rejects these parameters outright.
const N = 2 ** 17
const R = 8
const P = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const MAX_MEM = 256 * 1024 * 1024

/// Self-describing so the parameters can be raised later without invalidating
/// every existing password: a hash carries the cost it was made with, and
/// `needsRehash` reports when a stored hash is behind the current policy.
const PREFIX = 'scrypt'

export interface PasswordPolicyViolation {
  code: 'too_short' | 'too_long' | 'too_common'
  message: string
}

/// Passwords the product refuses regardless of length. Deliberately tiny - a
/// real breached-password check belongs behind an API (k-anonymity range
/// query), not in a hardcoded list that grows into a liability.
const OBVIOUS_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwertyuiop',
  'letmein123',
  'iloveyou1',
  'admin123',
  'welcome123',
])

/// ROLE-05 asks for "strong passwords". Length is the requirement that
/// actually correlates with strength; composition rules (one upper, one digit,
/// one symbol) push people toward `Password1!` and are not imposed here.
/// NIST SP 800-63B agrees: length and a blocklist, not character classes.
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 256

export function validatePassword(password: string): PasswordPolicyViolation[] {
  const violations: PasswordPolicyViolation[] = []

  if (password.length < MIN_PASSWORD_LENGTH) {
    violations.push({
      code: 'too_short',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    })
  }
  // Bounded so a multi-megabyte password cannot turn one login into a
  // denial-of-service against a deliberately expensive hash function.
  if (password.length > MAX_PASSWORD_LENGTH) {
    violations.push({
      code: 'too_long',
      message: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    })
  }
  if (OBVIOUS_PASSWORDS.has(password.toLowerCase())) {
    violations.push({
      code: 'too_common',
      message: 'That password is too easy to guess. Choose another.',
    })
  }

  return violations
}

export async function hashPassword(password: string): Promise<string> {
  const violations = validatePassword(password)
  if (violations.length > 0) {
    throw new Error(
      `Refusing to hash a password that fails policy: ${violations
        .map((v) => v.code)
        .join(', ')}`,
    )
  }

  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  })

  return [
    PREFIX,
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * Constant-time verification. Returns false for a malformed stored hash rather
 * than throwing, so a corrupted row denies access instead of leaking a
 * distinguishable error to the caller.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parsed = parseHash(storedHash)
  if (!parsed) return false

  // Bound the work an attacker can force per request, matching hashPassword.
  if (password.length > MAX_PASSWORD_LENGTH) return false

  let derived: Buffer
  try {
    derived = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    })
  } catch {
    return false
  }

  return derived.length === parsed.hash.length &&
    timingSafeEqual(derived, parsed.hash)
}

/// True when a stored hash was made with weaker parameters than current
/// policy. Call after a successful verify, while the plaintext is still in
/// hand, and re-hash if it returns true.
export function needsRehash(storedHash: string): boolean {
  const parsed = parseHash(storedHash)
  if (!parsed) return true
  return parsed.N < N || parsed.r < R || parsed.p < P
}

interface ParsedHash {
  N: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

function parseHash(storedHash: string): ParsedHash | null {
  const parts = storedHash.split('$')
  if (parts.length !== 6) return null

  const [prefix, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (prefix !== PREFIX) return null

  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null
  }
  // A hostile stored value must not be able to request unbounded memory.
  if (N < 2 ** 12 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    return null
  }

  const salt = Buffer.from(rawSalt!, 'base64')
  const hash = Buffer.from(rawHash!, 'base64')
  if (salt.length === 0 || hash.length === 0) return null

  return { N, r, p, salt, hash }
}
