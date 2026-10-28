import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type Found, NavSignal, WEB, call, discover, keyOfFound, unguardedEntrypoints } from './harness.ts'
import { PLATFORM_PERMISSIONS } from '@rental/core/rbac'
import { type PlatformEntry, platformManifest } from './platform.manifest.ts'

// PLAT-02 (PRD 11 §7.1, R-294c): every console page, layout and route handler
// guards first with `requirePlatform` - not merely with SOME guard, which is
// all ORG-05 asks - and every platform action refuses an org staff session
// before its first query, and a step-up action refuses a stale code.
//
// The org session is real here (`auth()` answers a staff principal) and the
// request is on PLATFORM_HOST, which is the shape of the attack: somebody
// signed in to an org, pointing their cookies at the console.

const HOST = 'platform.localhost'
vi.stubEnv('PLATFORM_HOST', HOST)

const platform: {
  principal: { id: string; kind: 'platform'; email: string; name: string; mfaVerifiedAt: number } | null
  /// What the guard's assignment read answers: the admin's live roles.
  roles: { roleKey: string; role: { permissions: string[] } }[]
} = { principal: null, roles: [] }

vi.mock('@rental/db', async (importOriginal) => {
  const db = await importOriginal<typeof import('@rental/db')>()
  const { withWriteSpy } = await import('./write-spy.ts')
  const spied = withWriteSpy(db.prisma)
  // The admin is a fake id, so its roles come from the test rather than from
  // rows that, being undeletable, would outlive it.
  const prisma = new Proxy(spied, {
    get: (target, key) =>
      key === 'platformRoleAssignment' ? { findMany: async () => platform.roles } : Reflect.get(target, key),
  })
  return { ...db, prisma }
})
vi.mock('@/auth.ts', () => ({
  auth: async () => ({
    principal: { id: 'plat-02-staff', kind: 'staff', orgId: 'org_0', email: null, name: 'staff', mfaEnrolled: true, mfaVerified: true },
    expires: '2099-01-01T00:00:00Z',
  }),
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
  platformUpdate: async () => {
    throw new Error('platformUpdate reached by a harness call')
  },
  platformHandlers: {},
  currentPlatformPrincipal: async () => platform.principal,
  peekPlatformChallenge: async () => null,
  PLATFORM_MFA_PURPOSE: 'platform-mfa',
}))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: (to: string) => {
    throw new NavSignal('redirect', to)
  },
  notFound: () => {
    throw new NavSignal('notFound')
  },
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'platform.localhost:3100' }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, updateTag: () => {}, refresh: () => {} }))

const STRANGER_WRITES = /^RateLimitCounter\./
const STALE = () => Date.now() - 11 * 60_000
const ADMIN = { id: 'plat-02-admin', kind: 'platform' as const, email: 'a@example.test', name: 'a' }
const EVERYTHING = [{ roleKey: 'platform_owner', role: { permissions: [...PLATFORM_PERMISSIONS] } }]

function manifestFindings(found: Found[], entries: Record<string, PlatformEntry>): string[] {
  const keys = new Set(found.map(keyOfFound))
  return [
    ...Object.keys(entries).filter((k) => !keys.has(k)).map((k) => `${k}: manifest entry has no export`),
    ...[...keys].filter((k) => !(k in entries)).map((k) => `${k}: no entry in tests/invariants/platform.manifest.ts`),
  ]
}

async function runPlatform(found: Found[], entries: Record<string, PlatformEntry>): Promise<string[]> {
  const out: string[] = []
  for (const f of found) {
    const entry = entries[keyOfFound(f)]
    if (!entry) continue
    const action = keyOfFound(f)
    const drive = () => call(f, () => '', { [action]: {} })

    // An org staff session and no platform one.
    platform.principal = null
    const asStaff = await drive()
    const wrote = asStaff.ops.filter((op) => op.write && !STRANGER_WRITES.test(op.name))
    if (wrote.length) out.push(`${action}: an org session wrote ${wrote.map((op) => op.name).join(', ')}`)
    else if ('guard' in entry && (asStaff.detail !== '/platform/login' || asStaff.ops.length)) {
      out.push(`${action}: an org session was not refused first (${asStaff.kind} ${String(asStaff.detail)}, ${asStaff.ops.length} queries)`)
    }

    // A platform session holding every role, whose last code is eleven
    // minutes old: refused for want of a code, not a permission.
    if ('guard' in entry && entry.guard === 'step-up') {
      platform.principal = { ...ADMIN, mfaVerifiedAt: STALE() }
      platform.roles = EVERYTHING
      const stale = await drive()
      if (!String(stale.detail).startsWith('/platform/step-up?next=') || stale.ops.length) {
        out.push(`${action}: a stale code was not sent to step-up first (${stale.kind} ${String(stale.detail)}, ${stale.ops.length} queries)`)
      }
    }

    // A fresh session holding no role: refused for want of the permission,
    // having written nothing.
    if ('guard' in entry && entry.permission) {
      platform.principal = { ...ADMIN, mfaVerifiedAt: Date.now() }
      platform.roles = []
      const bare = await drive()
      const wroteBare = bare.ops.filter((op) => op.write && !STRANGER_WRITES.test(op.name))
      if (bare.detail !== `/platform/no-access?permission=${encodeURIComponent(entry.permission)}` || wroteBare.length) {
        out.push(`${action}: an admin without ${entry.permission} was not refused (${bare.kind} ${String(bare.detail)}, ${wroteBare.length} writes)`)
      }
    }
  }
  platform.principal = null
  platform.roles = []
  return out
}

const CONSOLE = 'app/platform/**/{page,layout,template,default,route}.{ts,tsx}'

describe('PLAT-02: every platform entrypoint', () => {
  it('guards first with requirePlatform, or is a listed public sign-in route', () => {
    expect(unguardedEntrypoints(CONSOLE, undefined, undefined, ['requirePlatform'])).toEqual([])
  })

  it('has a platform manifest entry, and no entry is stale', async () => {
    expect(manifestFindings(await discover('lib/platform/**/*.ts'), platformManifest)).toEqual([])
  })

  it('refuses an org staff session before any query, and a stale code before any query', async () => {
    expect(await runPlatform(await discover('lib/platform/**/*.ts'), platformManifest)).toEqual([])
  }, 60_000)

  it('finds every platform action, because they all live in lib/platform', () => {
    // A 'use server' module elsewhere that calls the console's guard would be
    // a platform action this suite never drives.
    const stray = globSync('{app,lib,components}/**/*.{ts,tsx}', { cwd: WEB })
      .filter((rel) => !rel.startsWith('lib/platform/'))
      .filter((rel) => {
        const src = readFileSync(path.join(WEB, rel), 'utf8')
        return /^\s*['"]use server['"]/m.test(src) && src.includes('requirePlatform')
      })
    expect(stray).toEqual([])
  })
})

describe('PLAT-02 controls', () => {
  const controls = path.resolve(import.meta.dirname, 'controls')

  it('flags a console page behind the org guard, and passes one behind the platform guard', () => {
    expect(unguardedEntrypoints('platform/**/page.tsx', controls, {}, ['requirePlatform'])).toEqual([
      'platform/staff-guard/page.tsx: first await is requireStaff, not a guard',
    ])
  })

  it('flags a missing and a stale manifest entry', async () => {
    const found = await discover('platform-actions.ts', controls)
    const entries = Object.fromEntries(found.map((f) => [keyOfFound(f), { guard: 'session' } as PlatformEntry]))
    delete entries['platform-actions.ts#guarded']
    entries['platform-actions.ts#gone'] = { guard: 'session' }
    expect(manifestFindings(found, entries)).toEqual([
      'platform-actions.ts#gone: manifest entry has no export',
      'platform-actions.ts#guarded: no entry in tests/invariants/platform.manifest.ts',
    ])
  })

  it('flags a query before the guard, the org guard, a missing step-up and a missing permission', async () => {
    const found = await discover('platform-actions.ts', controls)
    const findings = await runPlatform(found, {
      'platform-actions.ts#queriesFirst': { guard: 'session' },
      'platform-actions.ts#staffGuarded': { guard: 'session' },
      'platform-actions.ts#noStepUp': { guard: 'step-up' },
      'platform-actions.ts#guarded': { guard: 'session' },
      'platform-actions.ts#steppedUp': { guard: 'step-up' },
      'platform-actions.ts#noPermission': { guard: 'session', permission: 'org.read' },
      'platform-actions.ts#permissioned': { guard: 'session', permission: 'org.read' },
      'platform-actions.ts#stepUpPermission': { guard: 'step-up', permission: 'platformAdmin.manage' },
    })
    expect(findings.map((f) => f.split(':')[0]).sort()).toEqual([
      'platform-actions.ts#noPermission',
      'platform-actions.ts#noStepUp',
      'platform-actions.ts#queriesFirst',
      'platform-actions.ts#staffGuarded',
    ])
  })
})
