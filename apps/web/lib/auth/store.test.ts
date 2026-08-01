import { RATE_LIMITS } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { consumeRateLimit, issueToken, redeemToken, revokeTokens } from './store.ts'

// Integration tests for the storage half of R-003. The policy is unit-tested
// in packages/core/auth; what needs a real database is the part that can only
// go wrong under concurrency - and single-use tokens and rate limits are
// exactly the two things where "checked, then wrote" quietly becomes "allowed
// twice" the moment two requests arrive together.
//
// AuthToken and RateLimitCounter are ordinary mutable tables, so unlike the
// evidence tables these can be cleaned up afterwards.

const SUBJECT_PREFIX = 'test-subject-'
const RATE_KEY_PREFIX = 'test-rl-'

beforeAll(() => {
  process.env.AUTH_SECRET ??= 'ZmFrZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMzJieXRlcw=='
})

afterEach(async () => {
  await prisma.authToken.deleteMany({
    where: { subjectId: { startsWith: SUBJECT_PREFIX } },
  })
  await prisma.rateLimitCounter.deleteMany({
    where: { key: { startsWith: RATE_KEY_PREFIX } },
  })
})

afterAll(async () => {
  await prisma.$disconnect()
})

let counter = 0
const nextSubject = () => `${SUBJECT_PREFIX}${Date.now()}-${counter++}`

describe('single-use tokens', () => {
  it('redeems a fresh token once', async () => {
    const subjectId = nextSubject()
    const { token } = await issueToken('TENANT_MAGIC_LINK', {
      type: 'Tenant',
      id: subjectId,
    })

    const first = await redeemToken(token, {
      purpose: 'TENANT_MAGIC_LINK',
      subjectType: 'Tenant',
    })
    expect(first).toMatchObject({ ok: true, subjectId })
  })

  it('refuses the second redemption', async () => {
    const { token } = await issueToken('TENANT_MAGIC_LINK', {
      type: 'Tenant',
      id: nextSubject(),
    })
    await redeemToken(token, {
      purpose: 'TENANT_MAGIC_LINK',
      subjectType: 'Tenant',
    })

    expect(
      await redeemToken(token, {
        purpose: 'TENANT_MAGIC_LINK',
        subjectType: 'Tenant',
      }),
    ).toEqual({ ok: false, reason: 'already_used' })
  })

  // The reason redeemToken uses a conditional updateMany and inspects the
  // affected-row count. A read-then-write would let both of these through, and
  // the failure mode is a forwarded magic link working twice.
  it('lets exactly one of ten simultaneous redemptions win', async () => {
    const { token } = await issueToken('TENANT_MAGIC_LINK', {
      type: 'Tenant',
      id: nextSubject(),
    })

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        redeemToken(token, {
          purpose: 'TENANT_MAGIC_LINK',
          subjectType: 'Tenant',
        }),
      ),
    )

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toHaveLength(9)
  })

  it('rejects an unknown token without revealing anything', async () => {
    expect(
      await redeemToken('not-a-real-token', {
        purpose: 'TENANT_MAGIC_LINK',
        subjectType: 'Tenant',
      }),
    ).toEqual({ ok: false, reason: 'not_found' })
  })

  it('rejects an expired token', async () => {
    const subjectId = nextSubject()
    const { token } = await issueToken('TENANT_MAGIC_LINK', {
      type: 'Tenant',
      id: subjectId,
    })

    const future = new Date(Date.now() + 60 * 60_000)
    expect(
      await redeemToken(
        token,
        { purpose: 'TENANT_MAGIC_LINK', subjectType: 'Tenant' },
        future,
      ),
    ).toEqual({ ok: false, reason: 'expired' })
  })

  // A reset link replayed at the magic-link endpoint must not sign anyone in.
  it('rejects a token presented for a different purpose', async () => {
    const { token } = await issueToken('STAFF_PASSWORD_RESET', {
      type: 'StaffUser',
      id: nextSubject(),
    })

    expect(
      await redeemToken(token, {
        purpose: 'TENANT_MAGIC_LINK',
        subjectType: 'Tenant',
      }),
    ).toEqual({ ok: false, reason: 'wrong_purpose' })
  })

  it('stores only a hash, so the database never holds a usable link', async () => {
    const subjectId = nextSubject()
    const { token } = await issueToken('TENANT_MAGIC_LINK', {
      type: 'Tenant',
      id: subjectId,
    })

    const rows = await prisma.authToken.findMany({ where: { subjectId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).not.toBe(token)
    expect(JSON.stringify(rows[0])).not.toContain(token)
  })

  it('carries metadata through to redemption, for vendor link scope', async () => {
    const subjectId = nextSubject()
    const { token } = await issueToken(
      'VENDOR_WORK_ORDER',
      { type: 'WorkOrder', id: subjectId },
      { metadata: { vendorId: 'vendor_1', abilities: ['accept'] } },
    )

    const result = await redeemToken(token, {
      purpose: 'VENDOR_WORK_ORDER',
      subjectType: 'WorkOrder',
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.metadata).toEqual({
      vendorId: 'vendor_1',
      abilities: ['accept'],
    })
  })
})

describe('token revocation', () => {
  // Password reset has to kill the other reset links sitting in the inbox, or
  // an attacker who requested one earlier still holds a working key.
  it('burns every outstanding token of a purpose for a subject', async () => {
    const subjectId = nextSubject()
    const a = await issueToken('STAFF_PASSWORD_RESET', {
      type: 'StaffUser',
      id: subjectId,
    })
    const b = await issueToken('STAFF_PASSWORD_RESET', {
      type: 'StaffUser',
      id: subjectId,
    })

    expect(await revokeTokens('STAFF_PASSWORD_RESET', subjectId)).toBe(2)

    for (const { token } of [a, b]) {
      expect(
        await redeemToken(token, {
          purpose: 'STAFF_PASSWORD_RESET',
          subjectType: 'StaffUser',
        }),
      ).toEqual({ ok: false, reason: 'already_used' })
    }
  })

  it('leaves other subjects alone', async () => {
    const mine = nextSubject()
    const theirs = nextSubject()
    await issueToken('STAFF_PASSWORD_RESET', { type: 'StaffUser', id: mine })
    const other = await issueToken('STAFF_PASSWORD_RESET', {
      type: 'StaffUser',
      id: theirs,
    })

    await revokeTokens('STAFF_PASSWORD_RESET', mine)

    expect(
      await redeemToken(other.token, {
        purpose: 'STAFF_PASSWORD_RESET',
        subjectType: 'StaffUser',
      }),
    ).toMatchObject({ ok: true })
  })
})

describe('rate limiting', () => {
  it('allows up to the limit, then blocks', async () => {
    const key = `${RATE_KEY_PREFIX}${nextSubject()}`
    const policy = { limit: 3, windowMs: 60_000 }

    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit(key, policy)).allowed).toBe(true)
    }

    const blocked = await consumeRateLimit(key, policy)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  // Without the advisory lock, simultaneous attempts all find no counter row
  // yet, all conclude they are opening a fresh window, and all are allowed -
  // which turns the limiter into a suggestion exactly when it is under attack.
  // (SELECT ... FOR UPDATE does NOT fix this: there is no row to lock.)
  //
  // Twenty transactions serialized behind one advisory lock, each a round trip
  // to a hosted database. Slow by construction, and slower when the rest of the
  // suite is competing for the same pool - so it gets a real timeout rather
  // than the 5s default it was quietly exceeding under load.
  it('does not let concurrent attempts exceed the limit', { timeout: 60_000 }, async () => {
    const key = `${RATE_KEY_PREFIX}${nextSubject()}`
    const policy = { limit: 5, windowMs: 60_000 }

    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(key, policy)),
    )

    expect(results.filter((r) => r.allowed)).toHaveLength(5)
  })

  it('opens a fresh window once the old one elapses', async () => {
    const key = `${RATE_KEY_PREFIX}${nextSubject()}`
    const policy = { limit: 2, windowMs: 60_000 }
    const t0 = new Date()

    await consumeRateLimit(key, policy, t0)
    await consumeRateLimit(key, policy, t0)
    expect((await consumeRateLimit(key, policy, t0)).allowed).toBe(false)

    const later = new Date(t0.getTime() + 61_000)
    expect((await consumeRateLimit(key, policy, later)).allowed).toBe(true)
  })

  it('keeps separate budgets per key', async () => {
    const a = `${RATE_KEY_PREFIX}${nextSubject()}`
    const b = `${RATE_KEY_PREFIX}${nextSubject()}`
    const policy = { limit: 1, windowMs: 60_000 }

    expect((await consumeRateLimit(a, policy)).allowed).toBe(true)
    expect((await consumeRateLimit(a, policy)).allowed).toBe(false)
    // One IP exhausting its budget must not lock out everyone else.
    expect((await consumeRateLimit(b, policy)).allowed).toBe(true)
  })

  it('uses a real login budget that is tight enough to matter', { timeout: 60_000 }, async () => {
    const key = `${RATE_KEY_PREFIX}${nextSubject()}`
    const attempts = await Promise.all(
      Array.from({ length: RATE_LIMITS.login.limit + 5 }, () =>
        consumeRateLimit(key, RATE_LIMITS.login),
      ),
    )
    expect(attempts.filter((a) => a.allowed)).toHaveLength(
      RATE_LIMITS.login.limit,
    )
  })
})
