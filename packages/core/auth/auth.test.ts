import { beforeAll, describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from './password.ts'
import {
  RATE_LIMITS,
  checkRateLimit,
  isLockedOut,
  lockoutUntil,
} from './rate-limit.ts'
import { openSecret, sealSecret } from './secret-box.ts'
import {
  checkToken,
  hashToken,
  matchRecoveryCode,
  mintRecoveryCodes,
  mintToken,
} from './tokens.ts'
import { createTotpEnrolment, verifyTotp } from './totp.ts'

beforeAll(() => {
  // secret-box derives its key from AUTH_SECRET. In CI and dev this comes from
  // .env.local via dotenv-cli; set a deterministic one here so the test does
  // not depend on the ambient environment either way.
  process.env.AUTH_SECRET = 'ZmFrZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMzJieXRlcw=='
})

const VALID_PASSWORD = 'correct-horse-battery-staple'

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword(VALID_PASSWORD)
    expect(await verifyPassword(VALID_PASSWORD, hash)).toBe(true)
    expect(await verifyPassword('wrong-horse-battery-staple', hash)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword(VALID_PASSWORD)
    const b = await hashPassword(VALID_PASSWORD)
    expect(a).not.toBe(b)
    // ...and both still verify.
    expect(await verifyPassword(VALID_PASSWORD, a)).toBe(true)
    expect(await verifyPassword(VALID_PASSWORD, b)).toBe(true)
  })

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword(VALID_PASSWORD)
    expect(hash).not.toContain(VALID_PASSWORD)
    expect(hash.startsWith('scrypt$')).toBe(true)
  })

  // A malformed row must deny access rather than throw - an exception here
  // would surface as a 500 and distinguish "corrupt account" from "wrong
  // password" to whoever is probing.
  it.each([
    ['empty', ''],
    ['not our format', 'plaintext-password'],
    ['wrong prefix', 'bcrypt$16384$8$1$c2FsdA$aGFzaA'],
    ['truncated', 'scrypt$16384$8$1$c2FsdA'],
    ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA$aGFzaA'],
    ['absurd cost, would exhaust memory', 'scrypt$999999999$8$1$c2FsdA$aGFzaA'],
  ])('returns false for a %s stored hash', async (_label, stored) => {
    await expect(verifyPassword(VALID_PASSWORD, stored)).resolves.toBe(false)
  })

  it('rejects passwords that fail policy', () => {
    expect(validatePassword('short')).toContainEqual(
      expect.objectContaining({ code: 'too_short' }),
    )
    expect(validatePassword('Password123')).toContainEqual(
      expect.objectContaining({ code: 'too_short' }),
    )
    expect(validatePassword('password123')).toContainEqual(
      expect.objectContaining({ code: 'too_common' }),
    )
    expect(validatePassword('x'.repeat(300))).toContainEqual(
      expect.objectContaining({ code: 'too_long' }),
    )
    expect(validatePassword(VALID_PASSWORD)).toEqual([])
  })

  it('refuses to hash a password that fails policy', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/policy/)
  })

  it('accepts a password of exactly the minimum length', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toEqual([])
  })

  it('flags a hash made with weaker parameters for rehashing', async () => {
    expect(needsRehash(await hashPassword(VALID_PASSWORD))).toBe(false)
    expect(needsRehash('scrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(true)
    expect(needsRehash('garbage')).toBe(true)
  })

  // A deliberately expensive hash is a denial-of-service primitive if the
  // input is unbounded.
  it('refuses an oversized password without doing the work', async () => {
    const hash = await hashPassword(VALID_PASSWORD)
    expect(await verifyPassword('x'.repeat(10_000), hash)).toBe(false)
  })
})

describe('single-use tokens', () => {
  it('stores a hash, not the token', () => {
    const { token, tokenHash } = mintToken('TENANT_MAGIC_LINK')
    expect(tokenHash).not.toBe(token)
    expect(tokenHash).toBe(hashToken(token))
    // Nothing in the stored value should reveal the clickable one.
    expect(tokenHash).not.toContain(token)
  })

  it('mints an unguessable token every time', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => mintToken('TENANT_MAGIC_LINK').token),
    )
    expect(tokens.size).toBe(200)
    // 32 bytes base64url.
    expect([...tokens][0]!.length).toBeGreaterThanOrEqual(43)
  })

  it('expires a magic link in 15 minutes', () => {
    const now = new Date('2026-08-01T12:00:00Z')
    const { expiresAt } = mintToken('TENANT_MAGIC_LINK', now)
    expect(expiresAt.toISOString()).toBe('2026-08-01T12:15:00.000Z')
  })

  const base = {
    purpose: 'TENANT_MAGIC_LINK',
    subjectType: 'Tenant',
    subjectId: 'tenant_1',
    expiresAt: new Date('2026-08-01T12:15:00Z'),
    consumedAt: null,
  }
  const now = new Date('2026-08-01T12:05:00Z')
  const expected = {
    purpose: 'TENANT_MAGIC_LINK',
    subjectType: 'Tenant',
    subjectId: 'tenant_1',
  } as const

  it('accepts a valid, unconsumed, unexpired token', () => {
    expect(checkToken(base, expected, now)).toEqual({ ok: true })
  })

  it('rejects a token that does not exist', () => {
    expect(checkToken(null, expected, now)).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('rejects a token that was already used', () => {
    expect(
      checkToken({ ...base, consumedAt: new Date() }, expected, now),
    ).toEqual({ ok: false, reason: 'already_used' })
  })

  it('rejects an expired token', () => {
    expect(
      checkToken(base, expected, new Date('2026-08-01T12:16:00Z')),
    ).toEqual({ ok: false, reason: 'expired' })
  })

  // A password-reset token replayed at the magic-link endpoint must not work,
  // and must report why truthfully.
  it('rejects a token presented for the wrong purpose', () => {
    expect(
      checkToken({ ...base, purpose: 'STAFF_PASSWORD_RESET' }, expected, now),
    ).toEqual({ ok: false, reason: 'wrong_purpose' })
  })

  it('rejects a token belonging to a different subject', () => {
    expect(checkToken({ ...base, subjectId: 'tenant_2' }, expected, now)).toEqual(
      { ok: false, reason: 'wrong_subject' },
    )
  })

  it('reports the real reason when a token is both wrong-purpose and expired', () => {
    expect(
      checkToken(
        { ...base, purpose: 'VENDOR_WORK_ORDER' },
        expected,
        new Date('2026-09-01T00:00:00Z'),
      ),
    ).toEqual({ ok: false, reason: 'wrong_purpose' })
  })
})

describe('recovery codes', () => {
  it('matches a code and returns the hash to spend', () => {
    const { codes, hashes } = mintRecoveryCodes(5)
    const matched = matchRecoveryCode(codes[2]!, hashes)
    expect(matched).toBe(hashes[2])
  })

  it('is case- and whitespace-forgiving, because these get typed by hand', () => {
    const { codes, hashes } = mintRecoveryCodes(3)
    expect(matchRecoveryCode(`  ${codes[0]!.toUpperCase()}  `, hashes)).toBe(
      hashes[0],
    )
  })

  it('rejects a code that was never issued', () => {
    const { hashes } = mintRecoveryCodes(5)
    expect(matchRecoveryCode('00000-00000', hashes)).toBeNull()
  })

  it('rejects everything once the list is empty', () => {
    const { codes } = mintRecoveryCodes(2)
    expect(matchRecoveryCode(codes[0]!, [])).toBeNull()
  })
})

describe('MFA secret encryption', () => {
  it('round-trips', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const sealed = sealSecret(secret)
    expect(sealed).not.toContain(secret)
    expect(openSecret(sealed)).toBe(secret)
  })

  it('produces a different ciphertext each time', () => {
    expect(sealSecret('JBSWY3DPEHPK3PXP')).not.toBe(
      sealSecret('JBSWY3DPEHPK3PXP'),
    )
  })

  it('returns null for a tampered ciphertext rather than garbage', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP')
    const [iv, ciphertext, tag] = sealed.split('.')
    // Flip the ciphertext but keep the original tag: GCM must catch it.
    const tampered = [iv, Buffer.from('evil').toString('base64url'), tag].join(
      '.',
    )
    expect(openSecret(tampered)).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['not our format', 'nonsense'],
    ['too few parts', 'aaa.bbb'],
    ['bad iv length', 'AA.bbb.cccccccccccccccccccccc'],
  ])('returns null for %s input', (_label, input) => {
    expect(openSecret(input)).toBeNull()
  })

  it('cannot be decrypted after AUTH_SECRET rotates', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP')
    const original = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = 'a-completely-different-secret-value-here=='
    expect(openSecret(sealed)).toBeNull()
    process.env.AUTH_SECRET = original
  })

  it('refuses to operate without AUTH_SECRET', () => {
    const original = process.env.AUTH_SECRET
    delete process.env.AUTH_SECRET
    expect(() => sealSecret('x')).toThrow(/AUTH_SECRET/)
    process.env.AUTH_SECRET = original
  })
})

describe('TOTP', () => {
  it('accepts a code generated for the same secret', async () => {
    const { secret, uri } = createTotpEnrolment('dana@example.com')
    expect(uri).toContain('otpauth://totp/')
    expect(uri).toContain('digits=6')

    const { TOTP, Secret } = await import('otpauth')
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate()
    expect(verifyTotp(secret, code)).toBe(true)
  })

  it('rejects a code generated for a different secret', async () => {
    const a = createTotpEnrolment('dana@example.com')
    const b = createTotpEnrolment('sam@example.com')
    const { TOTP, Secret } = await import('otpauth')
    const code = new TOTP({ secret: Secret.fromBase32(b.secret) }).generate()
    expect(verifyTotp(a.secret, code)).toBe(false)
  })

  it('issues a distinct secret per enrolment', () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => createTotpEnrolment('x').secret),
    )
    expect(secrets.size).toBe(50)
  })

  it.each([
    ['too short', '12345'],
    ['too long', '1234567'],
    ['non-numeric', 'abcdef'],
    ['empty', ''],
    ['injection-ish', '000000; DROP TABLE'],
  ])('rejects a %s code', (_label, code) => {
    const { secret } = createTotpEnrolment('dana@example.com')
    expect(verifyTotp(secret, code)).toBe(false)
  })

  it('tolerates spaces, because authenticator apps display codes grouped', async () => {
    const { secret } = createTotpEnrolment('dana@example.com')
    const { TOTP, Secret } = await import('otpauth')
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate()
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true)
  })

  it('returns false rather than throwing on a corrupted secret', () => {
    expect(verifyTotp('not-valid-base32!!!', '123456')).toBe(false)
  })
})

describe('rate limiting', () => {
  const policy = { limit: 3, windowMs: 60_000 }
  const t0 = new Date('2026-08-01T12:00:00Z')

  it('allows the first request and opens a window', () => {
    const decision = checkRateLimit(policy, null, t0)
    expect(decision.allowed).toBe(true)
    expect(decision.next).toEqual({ windowStartedAt: t0, count: 1 })
    expect(decision.remaining).toBe(2)
  })

  it('allows up to the limit, then blocks', () => {
    let window = checkRateLimit(policy, null, t0).next
    window = checkRateLimit(policy, window, t0).next
    const third = checkRateLimit(policy, window, t0)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)

    const fourth = checkRateLimit(policy, third.next, t0)
    expect(fourth.allowed).toBe(false)
    expect(fourth.retryAfterMs).toBe(60_000)
  })

  it('keeps counting while blocked, so hammering does not reset the window', () => {
    const blocked = { windowStartedAt: t0, count: 99 }
    const decision = checkRateLimit(policy, blocked, t0)
    expect(decision.allowed).toBe(false)
    expect(decision.next.count).toBe(100)
    expect(decision.next.windowStartedAt).toEqual(t0)
  })

  it('opens a fresh window once the old one has elapsed', () => {
    const exhausted = { windowStartedAt: t0, count: 3 }
    const later = new Date(t0.getTime() + 60_000)
    const decision = checkRateLimit(policy, exhausted, later)
    expect(decision.allowed).toBe(true)
    expect(decision.next).toEqual({ windowStartedAt: later, count: 1 })
  })

  it('reports a shrinking retry-after as the window drains', () => {
    const exhausted = { windowStartedAt: t0, count: 3 }
    const decision = checkRateLimit(
      policy,
      exhausted,
      new Date(t0.getTime() + 45_000),
    )
    expect(decision.retryAfterMs).toBe(15_000)
  })

  it('configures a tight window on MFA, which is only a million codes wide', () => {
    expect(RATE_LIMITS.mfaVerify.limit).toBeLessThanOrEqual(10)
  })
})

describe('account lockout', () => {
  const now = new Date('2026-08-01T12:00:00Z')

  it('does not lock below the threshold', () => {
    expect(lockoutUntil(0, now)).toBeNull()
    expect(lockoutUntil(4, now)).toBeNull()
  })

  it('backs off exponentially from the threshold', () => {
    expect(lockoutUntil(5, now)!.getTime() - now.getTime()).toBe(60_000)
    expect(lockoutUntil(6, now)!.getTime() - now.getTime()).toBe(120_000)
    expect(lockoutUntil(7, now)!.getTime() - now.getTime()).toBe(240_000)
  })

  // An uncapped lockout is a denial-of-service an attacker can trigger against
  // any account by failing its login on purpose.
  it('caps the lockout at an hour no matter how many failures', () => {
    expect(lockoutUntil(50, now)!.getTime() - now.getTime()).toBe(3_600_000)
    expect(lockoutUntil(5000, now)!.getTime() - now.getTime()).toBe(3_600_000)
  })

  it('reports a lock as expired once its moment passes', () => {
    const until = new Date(now.getTime() + 60_000)
    expect(isLockedOut(until, now)).toBe(true)
    expect(isLockedOut(until, new Date(now.getTime() + 60_001))).toBe(false)
    expect(isLockedOut(null, now)).toBe(false)
    expect(isLockedOut(undefined, now)).toBe(false)
  })
})
