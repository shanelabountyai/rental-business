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
import type { Org } from './fixture.ts'
import { type Op, ops, session } from './write-spy.ts'

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
      if (k === 'public' || k === 'unreached') continue
      if (k.startsWith('form.')) {
        const fields = tagged.get(f.file) ?? new Set()
        fields.add(k.slice(5))
        tagged.set(f.file, fields)
      }
      if (tag !== 'token' && tag !== 'value' && !tag.startsWith('=') && !MODELS.has(tag.replace(/\[\]$/, ''))) {
        out.push({ inv: 'HARNESS', action, detail: `"${k}" names "${tag}", which is not a model` })
      }
    }
  }
  // An id-like field the file reads that no entry in the file tags would be
  // filled with nothing and skip the cross-org swap silently.
  // Both `formData.get('x')` and a helper's `str(formData, 'x')`: R-286a saw
  // only the first, and 49 fields read through `str`/`all` went untagged.
  // ponytail: literal names in the action file only; a field read in an
  // imported builder is invisible here, and the own-org sanity call is what
  // catches an action that cannot be driven.
  for (const file of new Set(found.map((f) => f.file))) {
    const src = readFileSync(path.join(cwd, file), 'utf8')
    for (const m of src.matchAll(/(?:\.get(?:All)?\(|\b\w+\(\s*formData\s*,)\s*['"](\w+)['"]/g)) {
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
export async function call(f: Found, pick: (tag: Tag, path: string) => string, entries: Record<string, Entry> = manifest): Promise<Outcome> {
  const entry = entries[keyOf(f)]!
  const fn = f.fn as (...args: unknown[]) => Promise<unknown>
  const form = new FormData()
  for (const [k, tag] of Object.entries(entry)) {
    if (k.startsWith('form.')) form.append(k.slice(5), pick(tag, k))
  }
  const args = paramsOf(fn).map((p) => {
    if (/formData$/i.test(p)) return form
    if (PLAIN.test(p)) return undefined
    const tag = entry[p]!
    return tag === 'value' ? undefined : pick(tag, p)
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
    const o = await call(f, (tag) => (tag === 'token' ? 'org-harness-bad-token' : tag.startsWith('=') ? tag.slice(1) : NONEXISTENT), entries)
    const action = keyOf(f)
    const stray = o.ops.filter((op) => op.write && !STRANGER_WRITES.test(op.name))
    const linkOrPublic = entry.public !== undefined || Object.values(entry).includes('token')
    const detail = `${o.kind} ${JSON.stringify(o.detail ?? '').slice(0, 120)}, queries: ${o.ops.map((op) => op.name).join(', ') || 'none'}`
    if (stray.length) out.push({ inv: 'ORG-01', action, detail: `anonymous call wrote: ${detail}` })
    else if (!linkOrPublic && o.ops.length) out.push({ inv: 'ORG-01', action, detail: `anonymous call queried before refusing: ${detail}` })
  }
  return out
}

// ---- ORG-02/03/04: the two-org fixture (R-286c)

type Pick = (tag: Tag, path: string) => string
const ID_TAG = (tag: Tag) => tag !== 'token' && tag !== 'value' && !tag.startsWith('=')
const KINDS = { staff: 'owner', tenant: 'tenant', guarantor: 'guarantor' } as const
type Kind = keyof typeof KINDS
const PORTAL_LOGIN: Record<string, Kind> = { '/portal/login': 'tenant', '/portal/guarantor/login': 'guarantor' }

/** The paths of an entry that carry a row id: positional names and `form.` fields. */
export const idPaths = (entry: Entry) =>
  Object.entries(entry).filter(([k, t]) => k !== 'public' && k !== 'unreached' && ID_TAG(t)).map(([k]) => k)

/** Every model the manifest names, for the fixture to make one row of. */
export const manifestModels = (entries: Record<string, Entry> = manifest) => [
  ...new Set(Object.values(entries).flatMap((e) => idPaths(e).map((p) => e[p]!.replace(/\[\]$/, '')))),
]

function as(o: Org, kind: Kind) {
  session.principal = { id: o[KINDS[kind]], kind, email: null, name: `${kind} ${o.key}`, mfaEnrolled: true, mfaVerified: true }
}

const idOf = (o: Org) => (tag: Tag) => {
  const id = o.rows.get(tag[0]!.toUpperCase() + tag.replace(/\[\]$/, '').slice(1))
  if (!id) throw new Error(`no fixture row for "${tag}"`)
  return id
}
const pickFrom = (org: (path: string) => Org | null): Pick => (tag, path) => {
  if (tag === 'token') return 'org-harness-bad-token'
  if (tag === 'value') return ''
  if (tag.startsWith('=')) return tag.slice(1)
  const o = org(path)
  return o ? idOf(o)(tag) : NONEXISTENT
}

/** The outcome with every id the caller supplied replaced, so an echo of the id cannot differ. */
function shape(o: Outcome, ids: string[]): string {
  // A production build answers every thrown action error with the same
  // generic message and a digest, so two throws look identical to the caller
  // whatever their text (and their text names source lines, which differ).
  if (o.kind === 'threw') return '["threw"]'
  let s = JSON.stringify([o.kind, o.detail ?? null])
  for (const id of ids) s = s.split(id).join('<id>')
  // A row each call created (a redirect to `/compliance/<new id>`) is not an
  // answer that depends on the id supplied.
  return s.replace(/\bc[a-z0-9]{24}\b/g, '<new>')
}

// A cross-org call may write what the same call naming a missing row writes
// (an audit of the refusal, a rate-limit hit): ORG-04 asks for exactly that
// equivalence. Anything more is a write the other org's id caused.
const writes = (o: Outcome) => o.ops.filter((op) => op.write).map((op) => op.name)
function strays(cross: Outcome, missing: Outcome) {
  const left = writes(missing)
  return writes(cross).filter((w) => {
    const i = left.indexOf(w)
    return i < 0 || (left.splice(i, 1), false)
  })
}

export type OrgFinding = { inv: 'ORG-02' | 'ORG-03' | 'ORG-04' | 'SANITY'; action: string; detail: string }

/**
 * As org A's owner (or tenant, or guarantor: whichever the action's guard
 * asks for), each action is called with:
 *   - every id from org B (ORG-02): no write;
 *   - each id path swapped to org B alone, the rest org A's (ORG-03 when there
 *     is more than one): no write, and the same answer, byte for byte, as the
 *     same path naming a row that does not exist (ORG-04);
 *   - org A's own ids (sanity): the guard lets it through and the ids make a
 *     difference, or every check above was comparing two refusals of nothing.
 * Own-org calls run last, in a second pass, because they write: an earlier
 * action's success must not change what a later one is compared against.
 */
export async function runCrossOrg(
  found: Found[],
  { a, b, fresh }: { a: Org; b: Org; fresh: () => Promise<Org> },
  entries: Record<string, Entry> = manifest,
): Promise<OrgFinding[]> {
  const out: OrgFinding[] = []
  const bIds = [...b.rows.values(), NONEXISTENT]
  const driven: { f: Found; kind: Kind; missing: Outcome }[] = []
  for (const f of found) {
    const entry = entries[keyOf(f)]
    if (!entry || entry.public !== undefined || typeof f.fn !== 'function') continue
    const paths = idPaths(entry)
    if (!paths.length) continue
    const action = keyOf(f)
    const go = (pick: Pick) => call(f, pick, entries)

    // Whose guard is it? An all-missing call as staff answers "sign in at the
    // portal" for a tenant action, and changes nothing either way.
    let kind: Kind = 'staff'
    as(a, kind)
    let missing = await go(pickFrom(() => null))
    const portal = missing.kind === 'guard' ? PORTAL_LOGIN[String(missing.detail).split('?')[0]!] : undefined
    if (portal) {
      kind = portal
      as(a, kind)
      missing = await go(pickFrom(() => null))
    }

    const allB = await go(pickFrom(() => b))
    const leaked = strays(allB, missing)
    if (leaked.length) out.push({ inv: 'ORG-02', action, detail: `every id from org B wrote ${leaked.join(', ')}` })

    for (const p of paths) {
      // Missing first: a write org A's own ids cause (opening its own thread)
      // then happens on this call, and cannot read as caused by org B's id.
      const none = await go(pickFrom((at) => (at === p ? null : a)))
      const cross = await go(pickFrom((at) => (at === p ? b : a)))
      const extra = strays(cross, none)
      if (paths.length > 1 && extra.length) out.push({ inv: 'ORG-03', action, detail: `"${p}" from org B wrote ${extra.join(', ')}` })
      const [c, m] = [shape(cross, bIds), shape(none, bIds)]
      if (c !== m) out.push({ inv: 'ORG-04', action, detail: `"${p}": cross-org ${c.slice(0, 200)} ≠ nonexistent ${m.slice(0, 200)}` })
    }
    driven.push({ f, kind, missing })
  }

  for (const { f, kind, missing } of driven) {
    // ponytail: a token-link action is driven with a bad token, so its ids are
    // never reached and a sanity call proves nothing; minting a real link per
    // token kind is what would cover them.
    const entry = entries[keyOf(f)]!
    if (entry.unreached !== undefined || Object.values(entry).includes('token')) continue
    // Org A has absorbed every earlier own-org call (a tenant removed from
    // the lease, a template deactivated), so a failure is retried once on a
    // fresh org before it counts.
    let problem = await sanity(f, kind, missing, a, entries)
    if (problem) problem = await sanity(f, kind, missing, await fresh(), entries)
    if (problem) out.push({ inv: 'SANITY', action: keyOf(f), detail: problem })
  }
  session.principal = null
  return out
}

async function sanity(f: Found, kind: Kind, missing: Outcome, o: Org, entries: Record<string, Entry>): Promise<string | null> {
  as(o, kind)
  const own = await call(f, pickFrom(() => o), entries)
  const raw = JSON.stringify([own.kind, own.detail ?? null]).slice(0, 300)
  if (own.kind === 'guard' || (own.kind === 'redirect' && String(own.detail).startsWith('/no-access'))) return `own-org call was stopped: ${raw}`
  // Raw, not `shape`: two throws look alike to a caller, but a foreign-key
  // error on the row is not "no such row", and that difference is the question.
  const unshaped = (x: Outcome, ids: string[]) => ids.reduce((t, id) => t.split(id).join('<id>'), JSON.stringify([x.kind, x.detail ?? null]))
  if (unshaped(own, [...o.rows.values()]) === unshaped(missing, [NONEXISTENT]) && !own.ops.some((op) => op.write)) {
    return `own-org ids answer as nonexistent ones do: ${raw}`
  }
  return null
}
