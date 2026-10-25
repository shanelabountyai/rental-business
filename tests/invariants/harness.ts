// ORG-01/05 harness (PRD 10 §1.5, D-317), ported from saas foundation v1.3.0
// `tests/invariants/harness.ts`. It discovers every 'use server' export by
// glob, so nothing is registered by hand, takes each action's ids from
// actions.manifest.ts, and drives it with a spy on every Prisma write.
//
// What differs from the foundation, and why:
// - Ids come from a manifest, not zod `ref()` meta: these actions parse
//   FormData by hand (D-317).
// - No whole-database snapshot. `rental_test` is shared with every other test
//   file running in parallel, so "no table changed" is unanswerable there.
//   The write spy answers "did THIS call write", which is the question.
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Prisma } from '@rental/db'
import { PUBLIC_ROUTES } from '@/app/public-routes.ts'
import { type Entry, type Tag, manifest } from './actions.manifest.ts'
import { type Op, ops } from './write-spy.ts'

export type Finding = { inv: 'ORG-01' | 'HARNESS'; action: string; detail: string }
type Found = { file: string; name: string; fn: unknown }

const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use server\1/
export const WEB = path.resolve(import.meta.dirname, '../../apps/web')
const SRC = '**/*.{ts,tsx}'
const skip = (f: string) => f.includes('node_modules') || f.startsWith('.next')

/** Every export of every module whose first directive is 'use server'. */
export async function discover(pattern = SRC, cwd = WEB): Promise<Found[]> {
  const out: Found[] = []
  for (const rel of globSync(pattern, { cwd, exclude: skip }).sort()) {
    const file = path.join(cwd, rel)
    if (!USE_SERVER.test(readFileSync(file, 'utf8'))) continue
    for (const [name, fn] of Object.entries(await import(file))) out.push({ file: rel, name, fn })
  }
  return out
}

// Next registers an inline 'use server' function as an endpoint too, and
// discover() cannot see it. A directive anywhere but the top of the file is
// refused; move the action to an actions file.
const DIRECTIVE = /^\s*(['"])use server\1;?\s*$/gm
export function inlineUseServer(pattern = SRC, cwd = WEB): string[] {
  return globSync(pattern, { cwd, exclude: skip })
    .sort()
    .filter((rel) => {
      const src = readFileSync(path.join(cwd, rel), 'utf8')
      return (src.match(DIRECTIVE)?.length ?? 0) > (USE_SERVER.test(src) ? 1 : 0)
    })
}

// ORG-05: every page, layout and route handler guards itself, because a
// client-side navigation re-renders a page without re-running its layout.
// Each exported handler's first await must be a guard, or the file says why it
// is public with a `// public: <reason>` line. Awaiting `params` or
// `searchParams` reads the URL, not the database, so it may come first.
export const GUARDS = [
  'requireStaff',
  'requirePermission',
  'requireScope',
  'requireTenant',
  'requireTenantWithScope',
  'requireGuarantor',
  'requireGuarantorWithScope',
]
const HANDLER =
  /^export\s+(?:default\s+)?(?:async\s+)?function\b|^export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/gm
const URL_ONLY = /^(?:params|searchParams|props\.params|props\.searchParams|Promise\.all\(\[\s*params,\s*searchParams\s*\]\))/
export function unguardedEntrypoints(
  pattern = 'app/**/{page,layout,template,default,route}.{ts,tsx}',
  cwd = WEB,
  exempt: Record<string, string> = PUBLIC_ROUTES,
): string[] {
  const out: string[] = []
  for (const rel of globSync(pattern, { cwd }).sort()) {
    const src = readFileSync(path.join(cwd, rel), 'utf8')
    // route-guards.test.ts's list is the one place a route opts out with a reason.
    const key = rel.replace(/^app\//, '').split('/').filter((s) => !/^\(.+\)$/.test(s)).join('/')
    if (key in exempt || /^\/\/ public: \S/m.test(src)) continue
    const starts = [...src.matchAll(HANDLER)].map((m) => m.index)
    if (!starts.length) out.push(`${rel}: no exported handler found`)
    starts.forEach((at, i) => {
      const body = src.slice(at, starts[i + 1])
      const first = [...body.matchAll(/\bawait\s+(?=([\s\S]{1,120}))/g)].map((m) => m[1]!).find((a) => !URL_ONLY.test(a))
      // `await Promise.all([requireStaff(), …])` guards first too.
      const callee = (first?.match(/^Promise\.all\(\[\s*([\w$.]+)\(/)?.[1]) ?? first?.match(/^[\w$.]+/)?.[0]
      if (!GUARDS.includes(callee ?? '')) out.push(`${rel}: first await is ${callee ?? 'none'}, not a guard`)
    })
  }
  return out
}

// ---- manifest

const MODELS = new Set(Object.values(Prisma.ModelName).map((m) => m[0]!.toLowerCase() + m.slice(1)))
const PLAIN = /^_?(previous|prev|state|formData)$/
const ID_LIKE = /^id$|Ids?$/

/** Parameter names from the compiled function, so a default or a rename cannot hide one. */
export function paramsOf(fn: (...args: unknown[]) => unknown): string[] {
  const src = fn.toString()
  const open = src.indexOf('(')
  let depth = 0
  let end = open
  for (; end < src.length; end++) {
    if (src[end] === '(') depth++
    else if (src[end] === ')' && --depth === 0) break
  }
  const names: string[] = []
  let cur = ''
  depth = 0
  for (const ch of src.slice(open + 1, end)) {
    if ('({['.includes(ch)) depth++
    if (')}]'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      names.push(cur)
      cur = ''
    } else cur += ch
  }
  names.push(cur)
  return names.map((n) => n.trim().split(/[\s=]/)[0]!).filter(Boolean)
}

const keyOf = (f: Found) => `${f.file}#${f.name}`

/** Everything wrong with the manifest against what discover() found. */
export function manifestFindings(found: Found[], entries: Record<string, Entry> = manifest, cwd = WEB): Finding[] {
  const out: Finding[] = []
  const keys = new Set(found.map(keyOf))
  for (const key of Object.keys(entries)) {
    if (!keys.has(key)) out.push({ inv: 'HARNESS', action: key, detail: 'manifest entry has no export: remove it' })
  }
  const tagged = new Map<string, Set<string>>()
  for (const f of found) {
    const action = keyOf(f)
    const entry = entries[action]
    if (!entry) {
      out.push({ inv: 'HARNESS', action, detail: 'no manifest entry: add one to tests/invariants/actions.manifest.ts' })
      continue
    }
    if (typeof f.fn !== 'function') {
      out.push({ inv: 'HARNESS', action, detail: 'export is not a function, and every export of a use server module is an endpoint' })
      continue
    }
    for (const p of paramsOf(f.fn as (...args: unknown[]) => unknown)) {
      if (!PLAIN.test(p) && !(p in entry)) out.push({ inv: 'HARNESS', action, detail: `untagged parameter "${p}"` })
    }
    for (const [k, tag] of Object.entries(entry)) {
      if (k === 'public') continue
      if (k.startsWith('form.')) {
        const fields = tagged.get(f.file) ?? new Set()
        fields.add(k.slice(5))
        tagged.set(f.file, fields)
      }
      if (tag !== 'token' && tag !== 'value' && !MODELS.has(tag.replace(/\[\]$/, ''))) {
        out.push({ inv: 'HARNESS', action, detail: `"${k}" names "${tag}", which is not a model` })
      }
    }
  }
  // An id-like field the file reads that no entry in the file tags would be
  // filled with nothing and skip the cross-org swap silently.
  // ponytail: literal `formData.get('x')` in the action file only; a field read
  // in an imported builder is invisible here, and R-286b's own-org sanity call
  // is what catches an action that cannot be driven.
  for (const file of new Set(found.map((f) => f.file))) {
    const src = readFileSync(path.join(cwd, file), 'utf8')
    for (const m of src.matchAll(/\.get(?:All)?\(\s*['"](\w+)['"]/g)) {
      if (ID_LIKE.test(m[1]!) && !tagged.get(file)?.has(m[1]!)) {
        out.push({ inv: 'HARNESS', action: file, detail: `untagged id-like form field "${m[1]}"` })
      }
    }
  }
  return out
}

// ---- driving an action

/** Thrown by the test's next/navigation mock, so a redirect is an outcome and not a crash. */
export class NavSignal extends Error {
  readonly kind: 'redirect' | 'notFound'
  readonly to?: string
  constructor(kind: 'redirect' | 'notFound', to?: string) {
    super(`${kind} ${to ?? ''}`)
    this.kind = kind
    this.to = to
  }
}

const LOGINS = ['/login', '/portal/login', '/portal/guarantor/login']
export type Outcome = { kind: 'guard' | 'redirect' | 'notFound' | 'returned' | 'threw'; detail?: unknown; ops: Op[] }

export const NONEXISTENT = 'org-harness-nonexistent'

/** Calls an export the way a form post does: positional ids, then previous state, then FormData. */
export async function call(f: Found, pick: (tag: Tag) => string, entries: Record<string, Entry> = manifest): Promise<Outcome> {
  const entry = entries[keyOf(f)]!
  const fn = f.fn as (...args: unknown[]) => Promise<unknown>
  const form = new FormData()
  for (const [k, tag] of Object.entries(entry)) {
    if (k.startsWith('form.')) form.append(k.slice(5), pick(tag))
  }
  const args = paramsOf(fn).map((p) => {
    if (/formData$/i.test(p)) return form
    if (PLAIN.test(p)) return undefined
    const tag = entry[p]!
    return tag === 'value' ? undefined : pick(tag)
  })
  ops.length = 0
  let o: Omit<Outcome, 'ops'>
  try {
    o = { kind: 'returned', detail: await fn(...args) }
  } catch (e) {
    if (e instanceof NavSignal) {
      o = e.kind === 'notFound' ? { kind: 'notFound' } : { kind: LOGINS.includes(e.to!.split('?')[0]!) ? 'guard' : 'redirect', detail: e.to }
    } else o = { kind: 'threw', detail: `${(e as Error).name}: ${(e as Error).message}` }
  }
  return { ...o, ops: [...ops] }
}

// Writes a refused stranger may still cause: counting the attempt is the point
// of a rate limit, not a leak.
const STRANGER_WRITES = /^RateLimitCounter\./

/**
 * ORG-01: every export refuses an anonymous caller and writes nothing.
 *
 * A guarded action must refuse BEFORE ITS FIRST QUERY. Loading the record and
 * then letting `requirePermission` redirect a stranger to sign-in writes
 * nothing, but it answers differently for an id that exists ("sign in") and
 * one that does not ("no longer exists", or a Prisma throw): an existence
 * oracle for anybody on the internet. A public or token-link action reads by
 * design, so for it only the write half applies.
 */
export async function runAnonymous(found: Found[], entries: Record<string, Entry> = manifest): Promise<Finding[]> {
  const out: Finding[] = []
  for (const f of found) {
    const entry = entries[keyOf(f)]
    if (!entry || typeof f.fn !== 'function') continue
    const o = await call(f, (tag) => (tag === 'token' ? 'org-harness-bad-token' : NONEXISTENT), entries)
    const action = keyOf(f)
    const stray = o.ops.filter((op) => op.write && !STRANGER_WRITES.test(op.name))
    const linkOrPublic = entry.public !== undefined || Object.values(entry).includes('token')
    const detail = `${o.kind} ${JSON.stringify(o.detail ?? '').slice(0, 120)}, queries: ${o.ops.map((op) => op.name).join(', ') || 'none'}`
    if (stray.length) out.push({ inv: 'ORG-01', action, detail: `anonymous call wrote: ${detail}` })
    else if (!linkOrPublic && o.ops.length) out.push({ inv: 'ORG-01', action, detail: `anonymous call queried before refusing: ${detail}` })
  }
  return out
}
