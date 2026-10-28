import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type Org, retire, seedOrgWith } from './fixture.ts'
import { NavSignal, discover, manifestModels, runCrossOrg } from './harness.ts'

// ORG-02 another org's ids refused · ORG-03 one id swapped alone · ORG-04
// cross-org answers exactly as nonexistent · and an own-org sanity call per
// action (PRD 10 §1.5, R-286c). Milestone 19's gate: an action added without
// its manifest line fails org-01-05-06.test.ts, and one whose lookup is not
// org-scoped fails here.

vi.mock('@rental/db', async (importOriginal) => {
  const db = await importOriginal<typeof import('@rental/db')>()
  const { withWriteSpy } = await import('./write-spy.ts')
  return { ...db, prisma: withWriteSpy(db.prisma) }
})
vi.mock('@/auth.ts', async () => {
  const { session } = await import('./write-spy.ts')
  return {
    auth: async () => (session.principal ? { principal: session.principal, expires: '2099-01-01T00:00:00Z' } : null),
    signIn: async () => {
      throw new Error('signIn reached by a harness call')
    },
    signOut: async () => {},
    MfaRateLimited: class MfaRateLimited extends Error {},
    handlers: {},
  }
})
vi.mock('@/platform-auth.ts', () => ({
  // The console's Auth.js instance (R-294b). No harness caller is on
  // PLATFORM_HOST - the mocked headers carry no host - so every platform
  // action refuses before reaching these.
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
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, updateTag: () => {}, refresh: () => {} }))

const seeded: Org[] = []
const seed = async (key: string) => {
  const o = await seedOrgWith(key, manifestModels())
  seeded.push(o)
  return o
}
let a: Org
let b: Org
beforeAll(async () => {
  a = await seed('a')
  b = await seed('b')
}, 120_000)
afterAll(async () => {
  await retire(seeded)
})

describe('every server action, as org A', () => {
  it('refuses org B ids exactly as missing ones, and accepts its own', async () => {
    let n = 0
    const findings = await runCrossOrg(await discover(), { a, b, fresh: () => seed(`fresh-${++n}`) })
    expect(findings.map((f) => `${f.inv} ${f.action}: ${f.detail}`)).toEqual([])
  }, 900_000)
})

// Page-level ORG-04: the one by-id route that answers a stranger's id and a
// missing id differently by construction, because it serves three principals.
describe('GET /api/documents/[id]/file, as org A', () => {
  it("answers org B's document exactly as a missing one", async () => {
    const { GET } = await import('@/app/api/documents/[id]/file/route.ts')
    const { session } = await import('./write-spy.ts')
    session.principal = { id: a.owner, kind: 'staff', email: null, name: 'owner a', mfaEnrolled: true, mfaVerified: true }
    const get = async (id: string) => {
      try {
        const r = await GET(new Request('http://x'), { params: Promise.resolve({ id }) })
        return r.status
      } catch (e) {
        return e instanceof NavSignal ? `${e.kind} ${e.to}` : String(e)
      }
    }
    expect(await get(b.rows.get('Document')!)).toBe(await get('org-harness-nonexistent'))
    session.principal = null
  })
})

// Each control is known-bad. If one stops turning its check red, the check is blind.
describe('controls', () => {
  it('flag an unscoped write, an unscoped second id, an echo before authorisation and an undrivable action', async () => {
    const controls = path.resolve(import.meta.dirname, 'controls')
    const task = { taskId: 'task' }
    const findings = await runCrossOrg(
      await discover('cross-org.ts', controls),
      { a, b, fresh: () => seed('control-fresh') },
      {
        'cross-org.ts#unscopedWrite': task,
        'cross-org.ts#unscopedSecondary': { ...task, 'form.otherTaskId': 'task' },
        'cross-org.ts#echoBeforeAuthz': task,
        'cross-org.ts#undrivable': task,
        'cross-org.ts#scoped': task,
      },
    )
    expect(findings.map((f) => `${f.inv} ${f.action}`)).toEqual([
      'ORG-02 cross-org.ts#unscopedWrite',
      'ORG-03 cross-org.ts#unscopedSecondary',
      'ORG-04 cross-org.ts#echoBeforeAuthz',
      'SANITY cross-org.ts#undrivable',
    ])
  }, 120_000)
})
