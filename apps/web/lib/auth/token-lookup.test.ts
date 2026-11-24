import { randomUUID } from 'node:crypto'
import { RATE_LIMITS, hashToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// K5 (INV-09): unauthenticated token lookups are limited per IP in Postgres,
// counting only MISSES. Real database, because the claim is about the shared
// counter, not the arithmetic (that is checkRateLimit's own unit test).

const request = vi.hoisted(() => ({ ip: '' as string | null }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.ip ? { 'x-forwarded-for': `${request.ip}, 10.0.0.1` } : {}),
}))

const { issueToken, lookupAuthToken } = await import('./store.ts')

const stamp = `k5-${randomUUID().slice(0, 8)}`
const subjectId = `test-subject-${stamp}`
const ips = [1, 2, 3, 4].map((n) => `203.0.113.${n}-${stamp}`)
let realToken = ''

beforeAll(async () => {
  process.env.AUTH_SECRET ??= 'ZmFrZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMzJieXRlcw=='
  realToken = (await issueToken('TENANT_MAGIC_LINK', { type: 'Tenant', id: subjectId })).token
})

afterAll(async () => {
  await prisma.authToken.deleteMany({ where: { subjectId } })
  await prisma.rateLimitCounter.deleteMany({ where: { key: { in: ips.map((ip) => `token-miss:${ip}`) } } })
})

const guess = () => lookupAuthToken({ tokenHash: hashToken(`guess-${randomUUID()}`) })
const real = () => lookupAuthToken({ tokenHash: hashToken(realToken) })

describe('token lookup rate limit (K5)', () => {
  it('cuts an IP off after the miss budget, so even a real link reads as not found', async () => {
    request.ip = ips[0]!
    for (let i = 0; i < RATE_LIMITS.tokenLookupMiss.limit; i++) expect(await guess()).toBeNull()
    expect(await real()).toBeNull()

    const row = await prisma.rateLimitCounter.findUnique({ where: { key: `token-miss:${ips[0]}` } })
    expect(row?.count).toBe(RATE_LIMITS.tokenLookupMiss.limit)
  })

  it('does not spend the budget on hits: a renter reloading a real link is never limited', async () => {
    request.ip = ips[1]!
    for (let i = 0; i < RATE_LIMITS.tokenLookupMiss.limit + 5; i++) expect(await real()).not.toBeNull()
    expect(await prisma.rateLimitCounter.findUnique({ where: { key: `token-miss:${ips[1]}` } })).toBeNull()
  })

  it('keys on the client IP, so one guesser does not lock out another address', async () => {
    request.ip = ips[2]!
    expect((await real())?.subjectId).toBe(subjectId)
  })

  it('a window that has ended no longer refuses', async () => {
    request.ip = ips[3]!
    await prisma.rateLimitCounter.create({
      data: {
        key: `token-miss:${ips[3]}`,
        count: RATE_LIMITS.tokenLookupMiss.limit,
        windowStartedAt: new Date(Date.now() - RATE_LIMITS.tokenLookupMiss.windowMs - 1000),
      },
    })
    expect(await real()).not.toBeNull()
  })

  it('with no forwarded client address nothing is counted', async () => {
    request.ip = null
    expect(await guess()).toBeNull()
    expect(await real()).not.toBeNull()
  })
})
