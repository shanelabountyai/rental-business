import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PUBLIC_ROUTES } from './public-routes.ts'

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
  // R-165's guarantor portal, same shape as the tenant pair above.
  'requireGuarantor(',
  'requireGuarantorWithScope(',
  // The document download route branches on the session kind directly before
  // choosing between the staff and tenant rules, which is the same assertion
  // made by hand.
  '!session?.principal',
  // The platform console's guard (R-294b), with its permission (R-302a).
  'requirePlatform(',
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
  'app/(admin)/screening-criteria/page.tsx':
    'ScreeningCriteria applies to every applicant across the whole portfolio at once (the model\'s own doc comment) - owner policy, not law, but the same "no scoped resource" shape jurisdiction/page.tsx is exempted for.',
  'app/(admin)/screening-criteria/new/page.tsx': 'Same as the screening-criteria list above.',
  'lib/screening/criteria-actions.ts':
    'Same as the screening-criteria pages. Also a legal-release gate (OQ-6): a criteria change is the fair-housing standard every applicant in the portfolio is compared against.',
  'app/(admin)/messages/templates/page.tsx':
    'A managed message template is portfolio-wide (COMM-03, R-049): the same notice goes out from every property, and there is nothing property-shaped to scope it to. Refusing a property-scoped manager is the intended answer, not an accident.',
  'app/(admin)/messages/templates/new/page.tsx': 'Same as the template list above.',
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
  'app/(admin)/jobs/page.tsx':
    'A JobRun belongs to a property, but "did last night\'s work happen" does not (R-174): the panel answers a question about the whole deployment - every job, every property, and the jobs that have never run anywhere. Half that answer is worse than none, so refusing a scoped actor is the intended result.',
  'lib/jobs/actions.ts':
    'Same as the job-health panel above. The re-run is pressed FROM that screen. The manager role carries `job.manage` since R-197, so this refuses a property-scoped manager and admits a portfolio-wide one - the same line the panel draws.',
  'app/(admin)/staff/page.tsx':
    'A StaffUser carries no propertyId - the directory IS the portfolio (ROLE-04, R-138). The scope lives on StaffAssignment, which is what this screen edits, so a guard scoped to one property could not express "who may work here at all".',
  'app/(admin)/staff/new/page.tsx': 'Same as the staff list above.',
  'app/(admin)/staff/[id]/page.tsx': 'Same as the staff list above.',
  'lib/staff/actions.ts':
    'Same as the staff pages. `staff.manage` is owner-only and MFA-gated (PRIVILEGED_PERMISSIONS): handing somebody the keys is not a per-property act, and grantAssignment() re-checks the permission against the scope being granted anyway.',
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
  'app/(admin)/import/page.tsx':
    'Bulk-onboarding a portfolio (R-168) is the same act as minting a LegalEntity above - it can create entities and properties nothing yet scopes to, so only a portfolio-wide grant may run it.',
  'lib/import/actions.ts': 'Same as the import page above.',
  'lib/import/documents.ts':
    'Same as the import page above - the manifest can name a property in any entity, so there is no single resource to scope the guard to.',
  'lib/comms/messaging-settings-actions.ts':
    'R-266: the business name and the default reply assignee are one row for the whole deployment (D-332). The same file\'s quiet-hours action is checked against its property.',
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
