import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The test R-004 deferred until there was a route tree worth walking.
//
// ROLE-01: "Authorization enforced server-side per role and record scope, not
// just hidden UI." That is a property of EVERY route, and it is the kind of
// property a new page breaks silently - the page renders, nothing errors, and
// the only symptom is that the wrong person can read it.
//
// A reviewer cannot be relied on to notice a missing guard in a diff that adds
// a hundred lines of JSX. This walks app/ and fails the build instead.

const APP_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * Routes that are deliberately reachable without a guard, each with the reason
 * spelled out. Adding to this list is the only way to opt out, which makes
 * every exemption a reviewable line rather than an omission.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'page.tsx': 'The unauthenticated landing page.',
  'login/page.tsx': 'Sign-in. Guarding it would be a redirect loop.',
  'login/mfa/page.tsx':
    'The second factor. Reached mid-sign-in, before a session exists; the challenge cookie is the credential.',
  'forgot-password/page.tsx': 'Requesting a reset requires no session.',
  'reset-password/page.tsx':
    'The single-use token in the link is the credential; demanding a session would defeat the purpose.',
  'portal/login/page.tsx': 'Tenant sign-in.',
  'portal/verify/route.ts':
    'Where a magic link lands. The token is redeemed inside the Auth.js provider.',
  'api/auth/[...nextauth]/route.ts': 'Auth.js owns its own endpoints.',
  'api/cron/route.ts':
    'Authorized by a constant-time CRON_SECRET bearer check rather than a session - no human is signed in.',
  'manifest.webmanifest/route.ts':
    'The PWA manifest (D-8). A browser fetches it before any session exists, and it carries no data beyond the app name and icons.',
}

/// Any of these in a file counts as guarding it.
const GUARD_CALLS = [
  'requirePermission(',
  // Added in R-009 after this test passed R-008's own requireScope() pages
  // for the WRONG reason: their explanatory comments happened to also
  // contain the literal string "requirePermission(" while explaining why
  // that is NOT the right guard here, which was enough to satisfy the naive
  // substring match below even though the actual call was requireScope().
  // The unit detail page, with no such comment, caught the gap for real.
  'requireScope(',
  'requireStaff(',
  'requireTenant(',
  // R-018's portal pages almost all need the tenant AND their scope, so they
  // call the combined helper. Listed separately rather than shortening the
  // entry above to `requireTenant`: a bare prefix would also match a comment
  // mentioning the word, which is exactly how R-009 found this test passing
  // pages for the wrong reason.
  'requireTenantWithScope(',
  // The document download route branches on the session kind directly before
  // choosing between the staff and tenant rules, which is the same assertion
  // made by hand.
  'session?.principal.kind',
]

function walk(dir: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, prefix ? `${prefix}/${entry}` : entry))
      continue
    }
    if (entry === 'page.tsx' || entry === 'route.ts') {
      found.push(prefix ? `${prefix}/${entry}` : entry)
    }
  }
  return found
}

/// Route groups like `(admin)` add no URL segment, so they add none here.
function normalize(route: string): string {
  return route
    .split('/')
    .filter((segment) => !/^\(.+\)$/.test(segment))
    .join('/')
}

describe('every route is guarded (ROLE-01)', () => {
  const routes = walk(APP_DIR).map((route) => ({
    file: route,
    key: normalize(route),
  }))

  it('finds the routes it is supposed to be checking', () => {
    // Guards against the walk silently matching nothing after a refactor,
    // which would make this whole file pass for the wrong reason.
    expect(routes.length).toBeGreaterThanOrEqual(10)
    expect(routes.map((r) => r.key)).toContain('dashboard/page.tsx')
  })

  it.each(routes.filter((r) => !(r.key in PUBLIC_ROUTES)))(
    '$key calls a guard',
    ({ file }) => {
      const source = readFileSync(join(APP_DIR, file), 'utf8')
      const guarded = GUARD_CALLS.some((call) => source.includes(call))
      expect(
        guarded,
        `${file} has no authorization check. Call requirePermission() from ` +
          '@/lib/auth/guard.ts, or add it to PUBLIC_ROUTES with a reason.',
      ).toBe(true)
    },
  )

  it('does not exempt a route that no longer exists', () => {
    // A stale exemption is how a route becomes public again after being moved
    // and recreated somewhere else.
    const keys = new Set(routes.map((r) => r.key))
    const stale = Object.keys(PUBLIC_ROUTES).filter((key) => !keys.has(key))
    expect(stale).toEqual([])
  })

  it('guards every section the nav can reach', async () => {
    const { NAV_ITEMS } = await import('../lib/nav.ts')
    for (const item of NAV_ITEMS) {
      const key = `${item.href.replace(/^\//, '')}/page.tsx`
      expect(
        routes.some((route) => route.key === key),
        `nav points at ${item.href} but no route exists for it`,
      ).toBe(true)
      expect(PUBLIC_ROUTES).not.toHaveProperty(key)
    }
  })
})
