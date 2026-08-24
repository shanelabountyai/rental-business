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
  'api/webhooks/resend/route.ts':
    "Resend's delivery webhook (R-054's bounce/failure path). Same shape as the Twilio callbacks above but Svix-signed rather than HMAC-SHA1 - the svix-id/svix-timestamp/svix-signature headers, checked first over the raw body, refusing outright when RESEND_WEBHOOK_SECRET is unset - because Resend holds no credential of ours either way. It writes to NotificationDelivery or MessageDelivery, never to either append-only parent, and raises a Task (never a new column) when a hard bounce needs a human to fix a tenant's email on file.",
  'listings/[id]/page.tsx':
    "The hosted listing page (LEASE-01, R-056) - A NEW KIND OF PUBLIC ROUTE. Every other zero-login page in this list (vendor/[token], verify/[token], pay/[token]) is public because a SECRET in the path is the credential; this one is public because the RECORD ITSELF is meant to be public once published, and there is no secret anywhere in the URL - a listing id is guessable and indexable on purpose. `publicListing()` is the entire authorization: it returns a row only when `status: 'PUBLISHED'`, so a DRAFT or UNPUBLISHED listing 404s exactly like a record outside an actor's scope does everywhere else (ROLE-01) - 'not public' and 'does not exist' have to read the same to an anonymous visitor.",
  'listings/[id]/photos/[documentId]/route.ts':
    "Bytes for the public listing page above, same authorization as the page itself (a PUBLISHED listing owning this unit's photo) rather than any session. A separate route from api/documents/[id]/file for the same reason the vendor photo route is separate from it - see that route's own comment.",
  'prescreen/[token]/page.tsx':
    "A prospect's identical pre-screening questions (LEASE-07, R-058), answerable with no account - a prospect has none by definition. Same shape as verify/[token] and pay/[token]: the token in the path IS the credential, and `prescreenLinkStatus()` is the entire authorization. Single-use, unlike its two token-gated siblings, because the one answer a prospect ever gives is what the token itself guards - see AuthTokenPurpose.PROSPECT_PRESCREEN's own schema comment.",
  'apply/[token]/page.tsx':
    "One adult's own application (LEASE-03, R-059), answerable with no account - an applicant has none. Same shape as prescreen/[token]: the token in the path IS the credential, and `applicationLinkStatus()` is the entire authorization. MULTI-USE, unlike prescreen's single-use link, because a household gathering documents across several sittings must not find it dead partway through - see AuthTokenPurpose.APPLICATION_LINK's own schema comment.",
  'sign/[token]/page.tsx':
    "One signer's own review-and-sign page for a lease sent for e-signature (LEASE-06, DOC-02, R-063), answerable with no account - a co-tenant or guarantor may not have one yet either. Same shape as pay/[token]: the token in the path IS the credential and `verifySignerLink()` is the entire authorization. MULTI-USE like apply/[token], because reviewing a lease with family or an attorney before signing must not find the link dead - see AuthTokenPurpose.LEASE_SIGN's own schema comment. The actual sign action is a real form POST in esign-actions.ts, which re-verifies the token rather than trusting that this page rendered.",
  'sign/[token]/document/route.ts':
    "Bytes for the sign page above, authorized by the same token in the same path position - the same call vendor/[token]/documents/[documentId]/route.ts already makes for a vendor's magic link, kept as a separate route rather than a third branch inside api/documents/[id]/file for the identical reason that route's own header states. The token names the SIGNER, not a document id in the URL - verifySignerLink() decides which document (draft or executed) that signer may see.",
  'showings/[token]/page.tsx':
    "A prospect's own self-serve showing booking (LEASE-08, R-064), answerable with no account - a prospect has none. Same shape as prescreen/[token]: the token in the path IS the credential, and `showingLinkStatus()` is the entire authorization. Single-use like prescreen, not multi-use like sign/apply, because the one action a prospect ever takes with it is booking one slot - see AuthTokenPurpose.SHOWING_BOOKING's own schema comment. The actual booking is a real form POST in showings/actions.ts, which re-verifies the token and re-checks slot availability rather than trusting that this page rendered.",
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

// ===========================================================================
// A GUARD THAT CARRIES NO RESOURCE ONLY EVER MATCHES A PORTFOLIO-WIDE GRANT
// (R-103, ROLE-01, ROLE-04).
//
// `can()`'s `assignmentCovers` ends at `resource.legalEntityId ===
// assignment.legalEntityId`, so calling `requirePermission('x.read')` with no
// resource compares `undefined` against a real id and refuses every entity-
// and property-scoped actor - on a page whose own scoped query would have
// shown them a perfectly real list. `requireScope` exists for exactly that
// question and its own comment has documented the bug since R-008.
//
// IT CAME BACK TWICE ANYWAY. R-007 shipped it across the section
// placeholders; R-008 fixed Properties and Leases and nobody swept the rest;
// R-091 then shipped two fresh pages and an action with it, and only an e2e
// scoping test caught them. Seven shipped list pages were unreachable for any
// non-owner scope by the time R-103 measured it. A rule three people have now
// broken is not a rule anybody is going to remember, so it is a test.
//
// The exemptions below are the genuinely portfolio-wide ones - config that is
// owned by no property, where refusing a scoped actor is the CORRECT answer
// and widening it would hand a property-scoped manager authority over every
// other property. Each is a reviewable line with its reason, the same shape
// PUBLIC_ROUTES uses above.
// ===========================================================================

const RESOURCE_LESS_GUARDS: Record<string, string> = {
  'app/(admin)/jurisdiction/page.tsx':
    'A JurisdictionRule applies by STATE, not by property (D-4) - there is no scoped resource to check it against. propertyResource() cannot be constructed for a thing no property owns.',
  'app/(admin)/jurisdiction/new/page.tsx': 'Same as the jurisdiction list above.',
  'lib/jurisdiction/actions.ts':
    'Same as the jurisdiction pages. Also a legal-release gate: a rule change alters the law this product believes in for every property in a state at once.',
  'app/(admin)/messages/templates/page.tsx':
    'A managed message template is portfolio-wide (COMM-03, R-049): the same notice goes out from every property, and there is nothing property-shaped to scope it to. Refusing a property-scoped manager is the intended answer, not an accident.',
  'app/(admin)/messages/templates/new/page.tsx': 'Same as the template list above.',
  'app/(admin)/messages/templates/[id]/page.tsx': 'Same as the template list above.',
  'lib/comms/template-actions.ts':
    'Same as the message-template pages. `template.approve` is on the same footing and stricter still - signing off a legal translation is a claim about wording used everywhere.',
  'app/(admin)/documents/templates/page.tsx':
    'A DocumentTemplate is portfolio-wide, selected by documentType and STATE (R-062, R-063) - never by property.',
  'app/(admin)/documents/templates/new/page.tsx': 'Same as the document-template list above.',
  'app/(admin)/documents/templates/[id]/page.tsx': 'Same as the document-template list above.',
  'lib/documents/template-actions.ts': 'Same as the document-template pages above.',
  'app/(admin)/inspections/templates/page.tsx':
    'An InspectionTemplate is a portfolio-wide checklist (PROP-08, R-068), applied to any unit rather than owned by a property.',
  'app/(admin)/inspections/templates/new/page.tsx': 'Same as the inspection-template list above.',
  'app/(admin)/inspections/templates/[id]/page.tsx': 'Same as the inspection-template list above.',
  'lib/inspections/template-actions.ts': 'Same as the inspection-template pages above.',
  'app/(admin)/vendors/page.tsx':
    'A Vendor belongs to no property. It carries trades and `serviceAreas`, and the same plumber is dispatched from several properties - there is no propertyId on the model to scope against.',
  'app/(admin)/vendors/new/page.tsx': 'Same as the vendor list above.',
  'app/(admin)/vendors/[id]/page.tsx': 'Same as the vendor list above.',
  'lib/vendors/staff-actions.ts': 'Same as the vendor pages above.',
  'lib/maintenance/actions.ts':
    "`setVendorEmergencyAvailability` writes the VENDOR record, not the ticket it is reached from - see its own comment. Portfolio-wide for the same reason the vendor pages are.",
  'app/(admin)/properties/entities/new/page.tsx':
    'Minting a LegalEntity is the act that CREATES a scope. Nothing exists yet to scope it to, and an entity-scoped manager conjuring new entities would be widening their own reach.',
  'lib/properties/actions.ts': 'Same as the entity form above - `createLegalEntity`, and it already says so.',
  'app/(admin)/maintenance/preventive/page.tsx':
    "A PreventiveMaintenanceTemplate has no propertyId - one template drives jobs across every unit it matches. LEFT RESOURCE-LESS DELIBERATELY AND IT IS THE WEAKEST ENTRY ON THIS LIST: the page already computes due counts through `currentScope`, so it was plainly written expecting scoped viewers, and today none can reach it. Opening it would also open the new/edit pages beside it, which is authority over every other property - a widening, and the dangerous direction to guess in. The real answer is to split viewing from editing, and R-103 deliberately did not do it unasked.",
  'app/(admin)/maintenance/preventive/new/page.tsx': 'Same as the preventive list above.',
  'app/(admin)/maintenance/preventive/[id]/page.tsx': 'Same as the preventive list above.',
  'lib/maintenance/preventive-actions.ts': 'Same as the preventive pages above.',
}

const RESOURCE_LESS = /requirePermission\(\s*'[a-z_.]+'\s*\)/

/**
 * Code lines only.
 *
 * Half a dozen files in this repo do the RIGHT thing and say so in a comment
 * that quotes the wrong thing verbatim - "requireScope, not a bare
 * requirePermission('task.read')". Matching raw source flagged every one of
 * them, which would have taught the next person that this test cries wolf and
 * to add their file to the exemption list to shut it up. That is a worse
 * outcome than not having the test.
 */
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

function walkSource(dir: string, prefix: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...walkSource(full, `${prefix}/${entry}`))
      continue
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      found.push(`${prefix}/${entry}`)
    }
  }
  return found
}

describe('a guard with no resource refuses every scoped actor (R-103)', () => {
  const WEB_DIR = join(APP_DIR, '..')
  const files = [...walkSource(join(WEB_DIR, 'app'), 'app'), ...walkSource(join(WEB_DIR, 'lib'), 'lib')]

  const offenders = files.filter((file) =>
    RESOURCE_LESS.test(codeLines(readFileSync(join(WEB_DIR, file), 'utf8'))),
  )

  it('finds the files it is supposed to be checking', () => {
    // The same self-check the route walk above carries: a regex that silently
    // stops matching would make this file pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100)
    expect(offenders.length).toBeGreaterThan(5)
  })

  it.each(offenders)('%s is a deliberate portfolio-wide guard', (file) => {
    expect(
      RESOURCE_LESS_GUARDS[file],
      `${file} calls requirePermission() with no resource, which refuses every ` +
        'entity- and property-scoped actor (R-103). Use requireScope() and let the ' +
        'scoped query decide, or add the file to RESOURCE_LESS_GUARDS with the ' +
        'reason it is genuinely portfolio-wide.',
    ).toBeDefined()
  })

  it('does not exempt a file that no longer needs it', () => {
    // A stale exemption is how the bug walks back in: the call gets fixed, the
    // line stays, and the next resource-less guard added to that file is
    // silently blessed.
    const found = new Set(offenders)
    expect(Object.keys(RESOURCE_LESS_GUARDS).filter((key) => !found.has(key))).toEqual([])
  })
})
