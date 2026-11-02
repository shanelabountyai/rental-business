import path from 'node:path'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Org, retire, seedOrgWith } from './fixture.ts'
import { type Found, NONEXISTENT, NavSignal, call, discover, keyOfFound, manifestModels } from './harness.ts'
import { manifest } from './actions.manifest.ts'
import { type SupportClaims, request } from './write-spy.ts'

// PLAT-05 a grant admits nothing unless live · PLAT-06 under a live grant
// every write is refused · PLAT-07 a support session's audit rows are
// PLATFORM and name the grant · PLAT-09 a support session and its entry token
// stay on their own org's host (PRD 11 §7.1, R-295b).
//
// The browser is stood in for at two seams only: the request's host (which
// org the request is for) and the support cookie's claims (which grant it
// says it holds). Everything after that - the grant row, the admin, the
// actor, every action's own guard - is the real code against the real
// database, under the write spy.

const BASE = 'orgs.plat.test'
vi.stubEnv('ORG_BASE_DOMAIN', BASE)
vi.stubEnv('AUTH_URL', process.env.AUTH_URL || 'http://localhost:3100')

vi.mock('@rental/db', async (importOriginal) => {
  const db = await importOriginal<typeof import('@rental/db')>()
  const { withWriteSpy } = await import('./write-spy.ts')
  return { ...db, prisma: withWriteSpy(db.prisma) }
})
// No org session at all: whatever a support cookie does, it does alone.
vi.mock('@/auth.ts', () => ({
  auth: async () => null,
  signIn: async () => {
    throw new Error('signIn reached by a harness call')
  },
  signOut: async () => {},
  MfaRateLimited: class MfaRateLimited extends Error {},
  handlers: {},
}))
vi.mock('@/platform-auth.ts', () => ({
  platformAuth: async () => null,
  platformSignIn: async () => {
    throw new Error('platformSignIn reached by a harness call')
  },
  platformSignOut: async () => {},
  platformHandlers: {},
  currentPlatformPrincipal: async () => null,
  peekPlatformChallenge: async () => null,
  PLATFORM_MFA_PURPOSE: 'platform-mfa',
}))
vi.mock('@/lib/support/cookie.ts', async () => {
  const { request } = await import('./write-spy.ts')
  return {
    SUPPORT_SESSION_COOKIE: '__Host-support.session',
    SUPPORT_COOKIE_OPTIONS: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    readSupportClaims: async () => request.support,
    sealSupportClaims: async () => 'sealed',
    clearSupportCookie: async () => {
      request.support = null
    },
  }
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: (to: string) => {
    throw new NavSignal('redirect', to)
  },
  permanentRedirect: (to: string) => {
    throw new NavSignal('redirect', to)
  },
  notFound: () => {
    throw new NavSignal('notFound')
  },
}))
vi.mock('next/headers', async () => {
  const { request } = await import('./write-spy.ts')
  return {
    headers: async () => new Headers(request.host ? { host: request.host } : {}),
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, updateTag: () => {}, refresh: () => {} }))

const STRANGER_WRITES = /^RateLimitCounter\./
const MINUTE = 60_000
const seeded: Org[] = []
const admins: string[] = []
let a: Org
let b: Org
let hostA: string
let hostB: string
let owner: string

async function hostOf(o: Org) {
  const { slug } = await prisma.organization.findUniqueOrThrow({ where: { id: o.id }, select: { slug: true } })
  return `${slug}.${BASE}`
}

async function newAdmin(tag: string) {
  const admin = await prisma.platformAdmin.create({
    data: { email: `plat-05-09-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`, name: `Support ${tag}` },
  })
  admins.push(admin.id)
  return admin
}

/// A grant in org A held by a fresh admin, in whatever state `data` says.
async function grant(tag: string, data: Record<string, unknown> = {}) {
  const admin = await newAdmin(tag)
  const adminId = admin.id
  // A real cookie is issued long after its admin row exists. Here the two are
  // a millisecond apart, and the database's clock can round the admin's
  // watermark past `Date.now()`, which reads as "signed out everywhere".
  const now = Math.max(Date.now(), admin.sessionsValidFrom.getTime())
  const row = await prisma.supportAccessGrant.create({
    data: {
      orgId: a.id,
      platformAdminId: adminId,
      kind: 'REQUESTED',
      reason: `PLAT harness grant: ${tag}`,
      requestedMinutes: 60,
      approvedByStaffId: owner,
      approvedAt: new Date(now - MINUTE),
      startsAt: new Date(now - MINUTE),
      expiresAt: new Date(now + 59 * MINUTE),
      ...data,
    },
  })
  return { grantId: row.id, adminId, orgId: a.id, issuedAt: now } satisfies SupportClaims
}

const as = (claims: SupportClaims | null, host = hostA) => {
  request.support = claims
  request.host = host
}

beforeAll(async () => {
  a = await seedOrgWith('plat-a', manifestModels())
  b = await seedOrgWith('plat-b', [])
  seeded.push(a, b)
  ;[hostA, hostB] = await Promise.all([hostOf(a), hostOf(b)])
  owner = a.owner
}, 120_000)

afterAll(async () => {
  as(null, '')
  await prisma.platformAdmin.updateMany({ where: { id: { in: admins } }, data: { active: false } })
  await retire(seeded)
})

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    const value = (await fn()) as { kind?: string } | null
    return `returned ${value?.kind ?? ''}`.trim()
  } catch (e) {
    return e instanceof NavSignal ? `${e.kind} ${e.to ?? ''}`.trim() : `threw ${(e as Error).message}`
  }
}

describe('PLAT-05: a grant admits nothing unless live', () => {
  it('lets a live grant in as read-only support, and turns every closed one away to /support/ended', async () => {
    const { requireStaff } = await import('@/lib/auth/guard.ts')
    const { supportSessionIsStillValid } = await import('@/lib/support/session.ts')
    const now = Date.now()

    const live = await grant('live')
    as(live)
    expect(await outcome(requireStaff)).toBe('returned support')

    const cases: [string, SupportClaims, string][] = [
      ['pending', await grant('pending', { approvedByStaffId: null, approvedAt: null, startsAt: null, expiresAt: null }), 'invalid'],
      [
        'denied',
        await grant('denied', {
          approvedByStaffId: null,
          approvedAt: null,
          startsAt: null,
          expiresAt: null,
          deniedByStaffId: owner,
          deniedAt: new Date(now),
        }),
        'invalid',
      ],
      ['revoked', await grant('revoked', { endedAt: new Date(now), endedByType: 'STAFF', endedById: owner }), 'revoked'],
      [
        'expired (clock moved, sweep not run)',
        await grant('expired', { approvedAt: new Date(now - 90 * MINUTE), startsAt: new Date(now - 90 * MINUTE), expiresAt: new Date(now - 30 * MINUTE) }),
        'expired',
      ],
    ]
    const deactivated = await grant('deactivated')
    await prisma.platformAdmin.update({ where: { id: deactivated.adminId }, data: { active: false } })
    cases.push(['admin deactivated', deactivated, 'admin_deactivated'])
    const signedOut = await grant('signed-out')
    await prisma.platformAdmin.update({ where: { id: signedOut.adminId }, data: { sessionsValidFrom: new Date(signedOut.issuedAt + 1000) } })
    cases.push(["admin's sign out everywhere", signedOut, 'admin_deactivated'])
    // A cookie naming a real grant but another admin is a forgery.
    cases.push(['claims naming another admin', { ...live, adminId: deactivated.adminId }, 'invalid'])

    for (const [name, claims, why] of cases) {
      expect(await supportSessionIsStillValid(claims, a.id), name).toEqual({ ok: false, why })
      as(claims)
      expect(await outcome(requireStaff), name).toBe('redirect /support/ended')
    }

    // Ended from inside: the banner's End now closes it for the next request.
    const { endSupportSession } = await import('@/lib/support/session-actions.ts')
    as(live)
    expect(await endSupportSession({}, new FormData())).toEqual({ notice: expect.stringContaining('ended') })
    expect(await outcome(requireStaff)).toBe('redirect /support/ended')
    expect(await supportSessionIsStillValid(live, a.id)).toEqual({ ok: false, why: 'ended_by_support' })
  })
})

/// Drives each action as the support session on org A's own ids and lists
/// every write it made, with every AuditLog create it attempted.
async function runAsSupport(found: Found[], entries: typeof manifest, claims: SupportClaims) {
  const pick = (tag: string) => {
    if (tag === 'token') return 'org-harness-bad-token'
    if (tag === 'value') return ''
    if (tag.startsWith('=')) return tag.slice(1)
    return a.rows.get(tag[0]!.toUpperCase() + tag.replace(/\[\]$/, '').slice(1)) ?? NONEXISTENT
  }
  const findings: string[] = []
  const audits: unknown[] = []
  let driven = 0
  for (const f of found) {
    const entry = entries[keyOfFound(f)]
    // A public or token-link action answers anybody, a support session
    // included, and ORG-01 already holds it to writing nothing for one.
    if (!entry || entry.public !== undefined || Object.values(entry).includes('token') || typeof f.fn !== 'function') continue
    // The support session's own presses end or drop the session: the one
    // write it may make, driven by PLAT-05 and PLAT-07 instead.
    if (keyOfFound(f).startsWith('lib/support/session-actions.ts#')) continue
    as(claims)
    const o = await call(f, pick, entries)
    driven++
    const wrote = o.ops.filter((op) => op.write && !STRANGER_WRITES.test(op.name))
    if (wrote.length) findings.push(`${keyOfFound(f)}: wrote ${wrote.map((op) => op.name).join(', ')} (${o.kind} ${JSON.stringify(o.detail ?? '').slice(0, 120)})`)
    audits.push(...o.ops.filter((op) => op.name === 'AuditLog.create').map((op) => op.args))
  }
  return { findings, audits, driven }
}

describe('PLAT-06: under a live grant every write is refused', () => {
  it("writes nothing through any server action, given the grant's own org's ids", async () => {
    const live = await grant('plat-06')
    const { findings, audits, driven } = await runAsSupport(await discover(), manifest, live)
    expect(findings).toEqual([])
    expect(driven).toBeGreaterThan(100)
    // PLAT-07 over the same run: nothing audited, or audited as support.
    for (const args of audits) {
      expect((args as { data: Record<string, unknown> }).data).toMatchObject({ actorType: 'PLATFORM', supportGrantId: live.grantId })
    }
  }, 900_000)

  it('flags a write behind the staff floor alone, and passes one behind a write permission (control)', async () => {
    const controls = path.resolve(import.meta.dirname, 'controls')
    const { findings } = await runAsSupport(await discover('support-writes.ts', controls), {
      'support-writes.ts#writesBehindStaffFloor': {},
      'support-writes.ts#writesBehindWritePermission': {},
    }, await grant('plat-06-control'))
    expect(findings.map((f) => f.split(':')[0])).toEqual(['support-writes.ts#writesBehindStaffFloor'])
  })

  it('still reads (sanity): the guards admit it to its own org and refuse the privileged permissions', async () => {
    const live = await grant('plat-06-reads')
    as(live)
    const { requirePermission, requireScope } = await import('@/lib/auth/guard.ts')
    const property = await prisma.property.findFirstOrThrow({ where: { orgId: a.id }, select: { id: true, legalEntityId: true, orgId: true } })
    const resource = { orgId: property.orgId, propertyId: property.id, legalEntityId: property.legalEntityId }
    expect(await outcome(() => requirePermission('lease.read', resource))).toBe('returned support')
    expect((await requireScope('property.read')).scope).toEqual({ orgId: a.id, everything: true })
    for (const p of ['staff.manage', 'confidential.read', 'accesscode.reveal', 'ledger.adjust'] as const) {
      expect(await outcome(() => requirePermission(p, resource)), p).toBe(
        `redirect /no-access?permission=${encodeURIComponent(p)}&reason=no_permission`,
      )
    }
  })
})

describe('PLAT-07: an audit row written in a support session is PLATFORM and names the grant', () => {
  it('attributes audit() to the admin, in the grant org, under the grant', async () => {
    const live = await grant('plat-07')
    as(live)
    const { audit } = await import('@/lib/audit/index.ts')
    await audit({ action: 'support_grant.entered', entityType: 'SupportAccessGrant', entityId: live.grantId })
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: live.grantId, action: 'support_grant.entered' },
      orderBy: { occurredAt: 'desc' },
    })
    expect(row).toMatchObject({ actorType: 'PLATFORM', actorRef: live.adminId, orgId: a.id, supportGrantId: live.grantId, actorStaffId: null })

    const { endSupportSession } = await import('@/lib/support/session-actions.ts')
    await endSupportSession({}, new FormData())
    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { entityId: live.grantId, action: 'support_grant.ended' } }),
    ).toMatchObject({ actorType: 'PLATFORM', actorRef: live.adminId, supportGrantId: live.grantId })
  })
})

describe('PLAT-09: a support session and its entry token stay on their own host', () => {
  it("refuses org A's session on org B's host and on a host that names no org", async () => {
    const live = await grant('plat-09-session')
    const { supportSessionIsStillValid } = await import('@/lib/support/session.ts')
    expect(await supportSessionIsStillValid(live, b.id)).toEqual({ ok: false, why: 'wrong_host' })
    // The console's host names no org (orgIdForHost), so it is this case too.
    expect(await supportSessionIsStillValid(live, null)).toEqual({ ok: false, why: 'wrong_host' })
    const { requireStaff } = await import('@/lib/auth/guard.ts')
    as(live, hostB)
    expect(await outcome(requireStaff)).toBe('redirect /support/ended')
    as(live, hostA)
    expect(await outcome(requireStaff)).toBe('returned support')
  })

  it("burns org A's entry token on org B's host without opening anything, and opens one on A's", async () => {
    const live = await grant('plat-09-token')
    const { issueToken } = await import('@/lib/auth/store.ts')
    const { enterSupportSession } = await import('@/lib/support/session.ts')
    const meta = { ipAddress: null, userAgent: null }
    const subject = { type: 'SupportAccessGrant', id: live.grantId }

    const stolen = await issueToken('SUPPORT_ENTRY', subject)
    expect(await enterSupportSession(stolen.token, b.id, meta)).toBeNull()
    // Single use: having been tried on B, it is spent for A too.
    expect(await enterSupportSession(stolen.token, a.id, meta)).toBeNull()

    const fair = await issueToken('SUPPORT_ENTRY', subject)
    const entered = await enterSupportSession(fair.token, a.id, meta)
    expect(entered?.claims).toMatchObject({ grantId: live.grantId, adminId: live.adminId, orgId: a.id })
    // The cookie lives no longer than the grant.
    expect(entered!.maxAgeSeconds).toBeLessThanOrEqual(59 * 60)
    expect(await prisma.auditLog.count({ where: { action: 'support_grant.entered', supportGrantId: live.grantId, actorType: 'PLATFORM' } })).toBe(1)
    // An entry token for a grant that is not live opens nothing either.
    const closed = await grant('plat-09-closed', { endedAt: new Date(), endedByType: 'STAFF', endedById: owner })
    const late = await issueToken('SUPPORT_ENTRY', { type: 'SupportAccessGrant', id: closed.grantId })
    expect(await enterSupportSession(late.token, a.id, meta)).toBeNull()
  })

  it('keeps every support path off the console host', async () => {
    const { platformRouteRefused } = await import('@/lib/auth/platform-host.ts')
    expect(platformRouteRefused('platform.localhost:3100', '/support/enter', 'platform.localhost')).toBe(true)
    expect(platformRouteRefused('platform.localhost:3100', '/support/ended', 'platform.localhost')).toBe(true)
  })
})
