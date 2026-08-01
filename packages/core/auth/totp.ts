import { Secret, TOTP } from 'otpauth'

// TOTP via `otpauth` rather than node:crypto by hand. The algorithm itself is
// short, but a correct implementation also needs base32 codec, the otpauth://
// provisioning URI, and a drift window - roughly a hundred lines of
// security-critical code to write and maintain. That is past the point where
// "a few lines" justifies avoiding a small, zero-dependency library.

const ISSUER = 'Rental Operations'
const DIGITS = 6
const PERIOD_SECONDS = 30

/// Accept the immediately previous and next step as well as the current one.
/// One step either side covers ordinary phone clock drift and the user who
/// starts typing at second 29. Widening this multiplies the guess space an
/// attacker gets per window, so it stays at 1.
const DRIFT_WINDOW = 1

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  })
}

export interface TotpEnrolment {
  /// Base32. Encrypt with sealSecret() before it goes anywhere near the
  /// database.
  secret: string
  /// Feed to a QR renderer, or show as text for manual entry.
  uri: string
}

export function createTotpEnrolment(accountLabel: string): TotpEnrolment {
  // 20 bytes / 160 bits, the size RFC 4226 specifies for HMAC-SHA1.
  const secret = new Secret({ size: 20 })
  return {
    secret: secret.base32,
    uri: totpFor(secret.base32, accountLabel).toString(),
  }
}

/**
 * True when `code` is valid for `secretBase32` right now, within the drift
 * window. Returns false rather than throwing on a malformed secret or code, so
 * a corrupted row denies access instead of erroring.
 *
 * Replay is NOT handled here: a code stays valid for its whole 30-second step,
 * so an intercepted code can be reused within that window. Defeating that
 * needs a store of recently-used (userId, code) pairs. Not built, because the
 * exposure is 30 seconds against an attacker who already has the password and
 * a live intercept - and R-005's audit log is the thing that would catch it.
 */
export function verifyTotp(secretBase32: string, code: string): boolean {
  const normalized = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(normalized)) return false

  try {
    // `validate` returns the clock-step delta, or null when nothing matches.
    // otpauth compares digit strings internally; the value being compared is a
    // public 6-digit code rather than a secret, so a timing-safe compare here
    // would protect nothing that the drift window does not already expose.
    const delta = totpFor(secretBase32, 'verify').validate({
      token: normalized,
      window: DRIFT_WINDOW,
    })
    return delta !== null
  } catch {
    return false
  }
}
