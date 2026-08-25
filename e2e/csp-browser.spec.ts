import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'

// What the Content-Security-Policy actually DOES in a browser (D-138).
//
// ==========================================================================
// `csp.spec.ts` PROVES THE HEADER SAYS THE RIGHT WORDS. THIS PROVES THE
// BROWSER ACTS ON THEM.
//
// D-138's own "what it left behind" named this gap in as many words: the
// suite proved pages work and the header is correct, and nothing proved that
// no resource was being silently blocked. Those are different failures. A
// policy one directive too tight breaks a stylesheet or an image on a screen
// no assertion happens to look at, and every test stays green - the header
// is perfect, the page is subtly broken, and nobody finds out until a tenant
// does.
//
// THE TRAP THIS FILE IS BUILT AROUND is the one CLAUDE.md says has been hit
// three times: a detector that never fires looks exactly like a clean run.
// An empty violation list is the expected result of BOTH "the policy is
// correct" and "the listener was never registered". So the first test here
// is a NEGATIVE CONTROL - it makes the browser commit a violation on purpose
// and asserts the detector catches it. If that test ever passes vacuously,
// the rest of this file is worthless, and it fails loudly instead.
//
// It also happens to be the only thing in the repo that proves the CSP stops
// a real injection rather than merely describing one.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []

interface Violation {
  directive: string
  blocked: string
}

/**
 * Registers a `securitypolicyviolation` listener before any page script runs.
 *
 * The DOM event rather than console scraping, deliberately: a console filter
 * has to match wording that varies by browser and version, and it cannot
 * tell a CSP refusal from any other red line in the log. This reports the
 * violated directive and the blocked URI as structured data.
 *
 * MUST be called before `goto` - `addInitScript` runs before the document's
 * own scripts, which is what lets it catch a violation caused by the very
 * first thing on the page.
 */
async function watchViolations(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const found: Violation[] = []
    ;(window as unknown as { __cspViolations: Violation[] }).__cspViolations = found
    document.addEventListener('securitypolicyviolation', (event) => {
      found.push({
        directive: (event as SecurityPolicyViolationEvent).violatedDirective,
        blocked: (event as SecurityPolicyViolationEvent).blockedURI,
      })
    })
  })
}

function violationsOn(page: import('@playwright/test').Page): Promise<Violation[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations ?? [],
  )
}

async function seedManager() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `CSP LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `CSP House-${stamp}`,
      addressLine1: '3 Policy Street',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  const email = `csp-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'CSP Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId: property.id },
  })
  // `manager` holds no privileged permission, so there is no MFA step - which
  // keeps this spec about the policy rather than about signing in.
  return { staff, property }
}

test.beforeEach(async ({ page }) => {
  // D-130: R-003 limits sign-in to ten attempts per IP per five minutes.
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
  await watchViolations(page)
})

test.afterAll(async () => {
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

/**
 * Routes allowed to be statically prerendered, and therefore allowed to
 * serve script the CSP will refuse.
 *
 * Both are framework error pages with no interactivity: a 404 and the
 * global error boundary. Forcing Next's own error boundaries to render per
 * request is a change with more risk than the defect it would fix, so they
 * are accepted rather than fixed - a decision, recorded, not an oversight.
 * The webmanifest carries no script at all.
 */
const MAY_BE_PRERENDERED = new Set(['/_global-error', '/_not-found', '/manifest.webmanifest'])

test('no NEW page is prerendered, because a prerendered page loses every script', async () => {
  // THE GUARD FOR THE WHOLE CLASS, not for the four pages that happened to
  // be caught. D-139 cost an item to find precisely because the symptom is
  // silence: a prerendered page has no request, so it carries no nonce, so
  // `'strict-dynamic'` leaves nothing to allow its script - and this product
  // uses real `<form action>` everywhere, so the page still works and no
  // assertion anywhere goes red.
  //
  // The tests above only watch the routes D-139 already knew about. A fifth
  // prerendered page added next month would sail past them. This reads what
  // the BUILD decided instead, so the check cannot go stale.
  const manifestPath = resolve(process.cwd(), 'apps/web/.next/prerender-manifest.json')
  let manifest: { routes?: Record<string, unknown> }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { routes?: Record<string, unknown> }
  } catch {
    // `E2E_DEV=1` serves from `next dev`, which writes no such manifest. The
    // check belongs to the production build the sweep normally runs against.
    test.skip(true, 'no production build present (E2E_DEV?)')
    return
  }

  const unexpected = Object.keys(manifest.routes ?? {})
    .filter((route) => !MAY_BE_PRERENDERED.has(route))
    .sort()

  expect(
    unexpected,
    'These routes are statically prerendered, so the CSP nonce cannot reach them and ' +
      'the browser will refuse every script they serve - silently, because a real ' +
      '<form action> still works without JavaScript. Add `export const dynamic = ' +
      "'force-dynamic'` to each page, or add it to MAY_BE_PRERENDERED with the reason.",
  ).toEqual([])
})

test('THE NEGATIVE CONTROL: the browser refuses an injected inline handler, and the detector sees it', async ({
  page,
}) => {
  await page.goto('/login')

  // AN INLINE EVENT HANDLER, which is what a stored-XSS payload actually
  // looks like once it lands in a page: markup the parser inserts, carrying
  // script in an attribute. `script-src` refuses it without `'unsafe-inline'`,
  // and `'strict-dynamic'` does not rescue it - trust propagates to scripts a
  // trusted script LOADS, never to an attribute the parser found.
  //
  // NOT `createElement('script')` + `textContent`, which was the first thing
  // tried here and which DOES execute under `'strict-dynamic'` - correctly,
  // and it is worth writing down so nobody "fixes" this test back. That path
  // requires the attacker to be running script already, at which point the
  // policy has nothing left to defend. The injection this file is about is
  // the one that arrives as markup.
  const executed = await page.evaluate(async () => {
    // `src="x"` is same-origin (allowed by img-src) and 404s, so the error
    // event fires and would run the handler if the policy let it.
    document.body.insertAdjacentHTML(
      'beforeend',
      '<img src="x" onerror="window.__injected = true">',
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    return (window as unknown as { __injected?: boolean }).__injected === true
  })

  expect(executed, 'an injected inline event handler must not execute').toBe(false)

  // AND THE DETECTOR MUST HAVE NOTICED. Without this half, every "no
  // violations" assertion below would also pass on a page where the listener
  // was never registered at all - which is the failure this file is built
  // around.
  const violations = await violationsOn(page)
  expect(
    violations.some((v) => v.directive.startsWith('script-src')),
    `expected a script-src violation, saw ${JSON.stringify(violations)}`,
  ).toBe(true)
})

test('the browser also refuses a resource from an origin the policy never named', async ({
  page,
}) => {
  await page.goto('/login')

  // Blocked before any request leaves the browser, so this touches no
  // network - which is why it is an image from a nonexistent host rather
  // than a script from a real one.
  await page.evaluate(async () => {
    const img = document.createElement('img')
    img.src = 'https://not-in-the-policy.example.test/tracker.png'
    document.body.appendChild(img)
    await new Promise((resolve) => setTimeout(resolve, 250))
  })

  const violations = await violationsOn(page)
  expect(violations.some((v) => v.directive.startsWith('img-src'))).toBe(true)
})

test('the public pages load with nothing blocked', async ({ page }) => {
  // ALL FOUR OF THESE WERE PRERENDERED AND THEREFORE ENTIRELY SCRIPTLESS
  // under the first cut of the policy, and the whole 1006-test sweep passed
  // anyway. They are named individually rather than sampled because they are
  // the exact set the prerender manifest listed.
  for (const path of ['/', '/login', '/forgot-password', '/portal/login', '/login/mfa']) {
    await page.goto(path)
    await expect(page.locator('body')).toBeVisible()
    expect(await violationsOn(page), `${path} blocked a resource`).toEqual([])
  }
})

test('the signed-in shell loads with nothing blocked', async ({ page }) => {
  // The page that matters most: the full app shell, where hydration, client
  // components and the navigation all live. A policy one directive too tight
  // shows up here first.
  const { staff } = await seedManager()

  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')

  // The page's own heading rather than the nav: the shell nav collapses
  // behind a menu on narrow viewports, so asserting its visibility would be
  // testing the responsive layout rather than the policy. What this test
  // needs is proof the dashboard actually rendered before the violation list
  // is read - an empty list off a blank page proves nothing.
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
  expect(await violationsOn(page), 'the dashboard blocked a resource').toEqual([])
})
