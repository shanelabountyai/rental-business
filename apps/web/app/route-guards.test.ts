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
  'api/cron/escalations/route.ts':
    "The five-minute emergency-escalation tick (NOTIF-05, R-029). Same CRON_SECRET bearer check as the hourly route, through the same shared isAuthorizedCron() - separate only because fifteen minutes cannot be measured by an hourly schedule.",
  'manifest.webmanifest/route.ts':
    'The PWA manifest (D-8). A browser fetches it before any session exists, and it carries no data beyond the app name and icons.',
  'vendor/[token]/page.tsx':
    "The zero-login vendor work-order page (D-6, D-16, R-025). A vendor has no account by design, so there is no session for requirePermission() to read - the token in the path IS the credential, and verifyVendorLink() is the authorization. It is scoped to exactly one work order, expires, is revoked by reissuing, dies when the job or the assignment does, and every action through it is audited with the vendor named. See lib/vendors/link.ts's header for the full control set and D-16 for why single-use was the wrong shape here.",
  'vendor/bid/[token]/page.tsx':
    "The zero-login BID request page (MAINT-04, D-6, R-026). Same shape as the dispatch page above - the token in the path is the credential and verifyBidLink() is the authorization - but a SEPARATE token purpose (VENDOR_BID), because bids need several vendors holding live links to one work order at once, which is the exact opposite of D-16's one-live-dispatch-link-per-work-order invariant. It refuses once the job has been assigned to somebody.",
  'vendor/[token]/documents/[documentId]/route.ts':
    "Bytes for the vendor page above, authorized by the same token in the same path position. Deliberately NOT a third principal branch inside api/documents/[id]/file: that route authorizes two kinds of SESSION, and a bearer token falling through to either is the shape R-018's own 'the tenant side never falls through to the staff side' lesson warns about. Refuses with 404 for a bad token AND for a valid token pointed at a document outside its own job.",
  'verify/[token]/page.tsx':
    "The zero-login 'was this fixed?' page (MAINT-07, COMM-02, R-032c). Same shape as the vendor pages above — the token in the path IS the credential and verifyVerifyLink() is the authorization — but for a TENANT, and it exists because the alternative was worse than no page at all: the verification SMS used to link into the portal, which sits behind requireTenant and redirects to an EMAIL-ONLY login with no return-to, so a tenant with a phone and no email (R-021's whole persona) could not answer at all. The token is scoped to one work order, one tenant and one ROUND; it opens no session, reads no document and moves no money, so a leaked one can at worst answer a maintenance question wrongly — which a PM sees on the timeline and can reopen. The ANSWER IS A POST, NEVER A GET, because SMS clients and carrier link-safety scanners follow URLs and would otherwise close jobs on the tenant's behalf.",
  'pay/[token]/page.tsx':
    "The zero-login PAY-NOW page (PAY-01, COMM-02, R-046, D-45). Same shape as verify/[token] above - the token in the path IS the credential and verifyPayLink() is the authorization - but this one can MOVE MONEY, so the control set is tighter in three ways. It is SHORTER-LIVED (three days, not seven, matching the vendor links rather than the verify link). It is scoped to ONE LeasePayer, not one tenant, so a tenant on two tenancies cannot pay - or even see the balance of - the other from August's link for unit A. And it opens NO PORTAL SESSION AT ALL: the backlog asked for 'a portal session scoped to paying only', which was deliberately not built, because a real session carrying a scope marker would need every one of twenty-four requireTenant call sites to refuse it and any one missed would hand a leaked link the tenant's messages, papers and lease documents - fail-OPEN, the exact shape lib/portal/guard.ts's own header warns about. A token-scoped page is fail-CLOSED by construction: there is no session for any other route to trust. What a leaked one can do is bounded and stated - see that lease's balance, and pay that lease's rent. Revoked by reissuing (so one live link per payer) and outright by revokePayLinks() for a legal-action hold; refuses a paused tenancy, a deactivated payer or tenant, and a payer whose tenant changed since issue. The token is RE-VERIFIED in the action, not trusted from the page that rendered the form.",
  'api/webhooks/stripe/route.ts':
    "Stripe's webhook endpoint (D-11, R-034). Authenticated by the `Stripe-Signature` HMAC-SHA256 header rather than a session - Stripe has no credentials of ours to present - and the check is the FIRST thing the route does, over the RAW body, before anything parses it. It refuses outright when STRIPE_WEBHOOK_SECRET is unset, the same posture api/cron takes with CRON_SECRET and api/sms/inbound takes with TWILIO_AUTH_TOKEN. This is where money enters the product's record under D-11, so the signature is the whole security boundary; see packages/core/billing/webhook-signature.ts for the algorithm and the replay window.",
  'api/sms/inbound/route.ts':
    "Twilio's inbound-SMS webhook (R-021). Authenticated by an HMAC-SHA1 request signature rather than a session - Twilio has no credentials of ours to present. The signature check is the FIRST thing the route does and it refuses outright when TWILIO_AUTH_TOKEN is unset, the same posture api/cron takes with CRON_SECRET.",
  'api/sms/status/route.ts':
    "Twilio's delivery-status callback (R-040e, D-38). Same authentication story as the inbound webhook next door - an HMAC-SHA1 request signature, checked first, refusing outright when TWILIO_AUTH_TOKEN is unset - because Twilio holds no credential of ours either way. It exists so `SENT` can stop meaning merely *the provider accepted it*: for entry_notice, which is legally significant and which a tenant may not switch off, the difference between accepted and delivered is the whole evidentiary value of the record. It writes only to NotificationDelivery, never to the append-only Notification, and every write is idempotent because callbacks are retried and unordered.",
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
