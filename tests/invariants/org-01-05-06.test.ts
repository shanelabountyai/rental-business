import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { manifest } from './actions.manifest.ts'
import { ORG_01_PENDING } from './org-01.pending.ts'
import { NavSignal, WEB, discover, inlineUseServer, manifestFindings, runAnonymous, unguardedEntrypoints } from './harness.ts'

// ORG-01 anonymous refused, ORG-05 guard-first, ORG-06 orgId on every
// org-owned model, plus the manifest R-286b drives ORG-02..04 from (PRD 10
// §1.5, D-317, D-341). Every 'use server' export in apps/web is found by glob.

vi.mock('@rental/db', async (importOriginal) => {
  const db = await importOriginal<typeof import('@rental/db')>()
  const { withWriteSpy } = await import('./write-spy.ts')
  return { ...db, prisma: withWriteSpy(db.prisma) }
})
vi.mock('@/auth.ts', () => ({
  auth: async () => null,
  signIn: async () => {
    throw new Error('signIn reached by an anonymous harness call')
  },
  signOut: async () => {},
  MfaRateLimited: class MfaRateLimited extends Error {},
  handlers: {},
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

describe('every server action', () => {
  it('is discovered by glob', async () => {
    const found = await discover()
    expect(found.length).toBeGreaterThan(250)
    expect(found.map((f) => f.name)).toEqual(expect.arrayContaining(['startStaffSignIn', 'saveDocumentTemplate', 'sendAnnouncement']))
  })

  it('has a complete, valid manifest entry', async () => {
    expect(manifestFindings(await discover())).toEqual([])
  })

  it('ORG-01: refuses an anonymous caller and writes nothing', async () => {
    const findings = await runAnonymous(await discover())
    expect(findings.filter((f) => f.detail.startsWith('anonymous call wrote'))).toEqual([])
    // The read-before-guard half is a ratchet until R-286b (org-01.pending.ts).
    expect(findings.map((f) => f.action).sort()).toEqual([...ORG_01_PENDING].sort())
  }, 300_000)

  it('has no inline use server the glob cannot see', () => {
    expect(inlineUseServer()).toEqual([])
  })
})

describe('ORG-05: every page, layout and route handler', () => {
  it('guards first, or says why it is public', () => {
    expect(unguardedEntrypoints()).toEqual([])
  })
})

// The org-less tables PRD 10 §1.2 names, each with why. Anything else is
// org-owned and must carry a required `orgId`.
const ORG_LESS: Record<string, string> = {
  Organization: 'the root itself',
  StaffUser: 'one row per human; membership is OrgMembership (D-318)',
  StaffCredential: "a StaffUser's password and MFA, as org-less as the user",
  Role: 'seeded system roles; per-org custom roles are out of scope (ROLE-07)',
  JurisdictionRule: 'a statute is not per org (D-4)',
  RateLimitCounter: 'keys gain an org component instead (R-288)',
  AuthToken: 'points at a subject that has an org',
  DecisionReason: 'global placeholder list until R-297 makes it per org',
}

describe('ORG-06: every org-owned model', () => {
  const schema = readFileSync(path.join(WEB, '../../packages/db/prisma/schema.prisma'), 'utf8')
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, body: m[2]! }))

  it('has orgId String NOT NULL', () => {
    const missing = models
      .filter((m) => !(m.name in ORG_LESS))
      .filter((m) => !/^\s+orgId\s+String\s/m.test(m.body))
      // The one nullable org (D-352): a CHECK allows null only on a PLATFORM
      // act about the platform itself (packages/db/schema.test.ts proves it).
      .filter((m) => !(m.name === 'AuditLog' && /^\s+orgId\s+String\?\s/m.test(m.body)))
      .map((m) => m.name)
    expect(missing).toEqual([])
  })

  it('keeps the org-less allowlist honest', () => {
    const names = new Set(models.map((m) => m.name))
    const stale = Object.keys(ORG_LESS).filter((n) => !names.has(n) || /^\s+orgId\s/m.test(models.find((m) => m.name === n)!.body))
    expect(stale).toEqual([])
  })
})

// Each control is known-bad. If one stops turning its check red, the check is blind.
describe('controls', () => {
  const controls = path.resolve(import.meta.dirname, 'controls')

  it('ORG-05 flags a late guard, a missing guard, one unguarded handler and a reasonless marker', () => {
    expect(unguardedEntrypoints('**/{page,layout,route}.{ts,tsx}', path.join(controls, 'entrypoints'), {})).toEqual([
      'late-guard/page.tsx: first await is prisma.property.findMany, not a guard',
      'no-guard/layout.tsx: first await is none, not a guard',
      'no-reason/page.tsx: first await is none, not a guard',
      'one-handler-unguarded/route.ts: first await is request.json, not a guard',
    ])
  })

  it('flags an inline use server', () => {
    expect(inlineUseServer('*.{ts,tsx}', controls)).toEqual(['inline-use-server.tsx'])
  })

  it('flags a missing entry, a stale entry, an untagged parameter, an untagged form field and a bad model', async () => {
    const found = await discover('unscoped.ts', controls)
    const details = manifestFindings(found, {
      'unscoped.ts#tagged': { leaseId: 'lease', 'form.vendorIds': 'vendor[]' },
      'unscoped.ts#badModel': { leaseId: 'leese' },
      'unscoped.ts#untagged': {},
      'unscoped.ts#gone': {},
    }, controls).map((f) => `${f.action}: ${f.detail}`)
    expect(details).toEqual([
      'unscoped.ts#gone: manifest entry has no export: remove it',
      'unscoped.ts#badModel: "leaseId" names "leese", which is not a model',
      'unscoped.ts#untagged: untagged parameter "workOrderId"',
      'unscoped.ts#missing: no manifest entry: add one to tests/invariants/actions.manifest.ts',
      'unscoped.ts: untagged id-like form field "ticketId"',
      'unscoped.ts: untagged id-like form field "unitId"',
    ])
  })

  it('ORG-01 flags a write before the guard and an action that never guards, and passes a guarded one', async () => {
    const found = await discover('writes-first.ts', controls)
    const tags = { taskId: 'task' }
    const findings = await runAnonymous(found, { 'writes-first.ts#writesFirst': tags, 'writes-first.ts#neverGuards': tags, 'writes-first.ts#guarded': tags })
    expect(findings.map((f) => `${f.action}: ${f.detail.split(':')[0]}`)).toEqual([
      'writes-first.ts#writesFirst: anonymous call wrote',
      'writes-first.ts#neverGuards: anonymous call queried before refusing',
    ])
  })

  it('every manifest key names a file under apps/web', () => {
    const files = new Set(Object.keys(manifest).map((k) => k.split('#')[0]!))
    expect([...files].filter((f) => !f.startsWith('lib/') && !f.startsWith('app/') && !f.startsWith('components/'))).toEqual([])
  })
})
