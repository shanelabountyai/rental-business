// Shared fixture helpers for the end-to-end suite.

import { randomUUID } from 'node:crypto'

let counter = 0

/**
 * A phone number no other fixture in this run is holding.
 *
 * EVERY e2e fixture used to hard-code one, and each seed helper is called
 * once per test per browser project - so a single run left ten active
 * tenants sharing one number. That is exactly the ambiguity `decideRoute`
 * refuses to guess at (COMM-01, R-017): a number matching more than one
 * party routes nowhere, on purpose, because filing a conversation under the
 * wrong person's permanent record is a cross-tenant data leak.
 *
 * It had already cost something. A crashed run left an active tenant
 * holding `sms-intake.test.ts`'s hard-coded number, and every run afterwards
 * saw two candidates and correctly declined to route - eight tests failing
 * on the feature working against its own fixture, for an unknown number of
 * runs before anybody read the error properly.
 *
 * Sequential rather than random: a collision that happens one run in a
 * thousand is worse than one that happens every time, because nobody ever
 * finds it.
 */
export function uniquePhone(): string {
  counter += 1
  // +1512 555 + a 6-digit slot. The worker pid keeps parallel Playwright
  // workers - which are separate processes with their own counter - apart.
  const slot = (process.pid % 1000) * 1000 + (counter % 1000)
  return `+1512555${String(slot).padStart(6, '0')}`
}

/**
 * Assert that a completed interaction left focus somewhere a keyboard or
 * screen-reader user can work from.
 *
 * THIS IS THE ASSERTION WHOSE ABSENCE LET THE WHOLE R-098/R-099 TIER THROUGH.
 * Two independent accessibility reviews of the product each arrived at the
 * same root cause and each noted the same reason it survived: `.focus()`
 * appeared literally zero times in `apps/web`, and nothing in the gate could
 * see that. axe scans a static snapshot — where focus WENT after a server
 * action or a state flip is invisible to it by construction, so a page could
 * fail this on every interaction and still pass the accessibility spec.
 *
 * When the element holding focus unmounts, the browser drops focus to
 * `<body>`. The user is silently returned to the top of the document and must
 * re-navigate to discover what happened; a screen reader announces nothing at
 * all. `<body>` is therefore the one answer that is always wrong.
 *
 * Checks `documentElement` too: some browsers report the root rather than the
 * body for the same condition, and treating one as a pass would make this
 * assertion quietly browser-dependent.
 */
export async function expectFocusSurvived(
  page: import('@playwright/test').Page,
  context: string,
): Promise<void> {
  const landed = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return null
    return el.tagName.toLowerCase()
  })

  if (landed === null) {
    throw new Error(
      `Focus was lost to <body> after: ${context}.\n` +
        'The element holding focus unmounted and nothing claimed focus in its ' +
        'place, so a keyboard user is back at the top of the document and a ' +
        'screen reader announced nothing. Move focus to whatever replaced it ' +
        '(a heading with tabIndex={-1}, the new control, or the result itself).',
    )
  }
}

/**
 * Asserts that an action announces through an EXISTING live region rather
 * than by creating one.
 *
 * The companion to `expectFocusSurvived`, and it exists for the same reason:
 * axe scans a static snapshot and cannot tell you whether anything was ever
 * spoken. A `role="status"` or `role="alert"` inserted together with its own
 * text is a NEW NODE rather than a change to an existing region, and
 * assistive technology routinely announces nothing at all — so the product
 * passes an audit and is silent in use.
 *
 * COUNTS BEFORE AND AFTER, deliberately. Merely asserting "a live region
 * exists" is far too weak on any screen that also renders `FormAlerts`: its
 * regions are always present, so the assertion passes while the region under
 * test is still being created at announce time. What must not change is the
 * NUMBER of regions.
 *
 * R-101 found this in `FormAlerts` itself, which reaches 49 components —
 * every form in the product, including the ones a tenant uses to report a
 * leak and pay rent.
 */
export async function expectAnnouncedInPlace(
  page: import('@playwright/test').Page,
  action: () => Promise<void>,
  context: string,
): Promise<void> {
  const selector = '[role="status"], [role="alert"]'
  const before = await page.locator(selector).count()
  await action()
  const after = await page.locator(selector).count()

  if (after > before) {
    throw new Error(
      `A live region was CREATED to announce: ${context} (${before} → ${after}).\n` +
        'A role="status" / role="alert" region must be in the accessibility ' +
        'tree BEFORE its text arrives — one rendered together with its own ' +
        'content is a new node, not a change, and is commonly not announced ' +
        'at all. Render the region unconditionally and put only the message ' +
        'inside it (see LiveRegion / FormAlerts in components/auth-form.tsx).',
    )
  }
}

/**
 * A distinct client IP per browser context, for the auth rate limiter.
 *
 * ==========================================================================
 * WITHOUT THIS, THE FULL SWEEP EATS ITS OWN LOGIN LIMIT. R-003 rate-limits
 * staff sign-in at ten attempts per IP per five minutes (`RATE_LIMITS.login`),
 * and local e2e traffic carries no `x-forwarded-for` - so every spec that does
 * not set one shares a single bucket keyed on the same address. Nine specs
 * were in that state when Golden Path 3's sweep found it, and past about the
 * two-hundredth test the eleventh login in five minutes starts being refused.
 *
 * THE SYMPTOM LOOKS NOTHING LIKE THE CAUSE, which is why this comment is
 * long: the failure is `page.waitForURL` timing out after clicking "Sign in",
 * sixty seconds later, inside whichever spec happened to be running - it
 * reads as a slow page or a broken form in a feature nobody touched. Both
 * failures in that sweep were in notice specs, and neither had anything to do
 * with notices.
 *
 * Several specs already did this inline. It is a helper now so the next spec
 * cannot forget, and so `browser.newContext()` - which does NOT inherit
 * `page.setExtraHTTPHeaders` - gets it too, which is the half that was
 * missing even in the specs that had remembered.
 * ==========================================================================
 */
export function uniqueClientHeaders(): Record<string, string> {
  const octet = () => Math.floor(Math.random() * 254) + 1
  return { 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` }
}

/**
 * A jurisdiction state code no other fixture, run or browser project is
 * holding.
 *
 * ==========================================================================
 * THE UNIQUE CONSTRAINT DOES NOT CATCH A REPEATED CODE (R-108).
 * `@@unique([state, jurisdiction, version])` looks like it makes a repeat
 * loud, and it does not: every fixture rule is statewide, so `jurisdiction`
 * is NULL, and Postgres treats NULLs as DISTINCT - two identical statewide
 * v1 rows insert without complaint. `rulesFor` then fetches BOTH and
 * `selectApplicableRule` breaks the effectiveFrom tie by keeping whichever
 * row came back first, so a test silently reads a different test's statute.
 *
 * THE SYMPTOM LOOKS NOTHING LIKE THE CAUSE. Nothing throws. The page renders
 * the other branch perfectly, and the failure is a 60s timeout on an
 * assertion in a feature nobody touched - `abandonment.spec.ts` drew its code
 * from 26 letters and lost roughly one run in twenty-four, a different test
 * each time.
 *
 * Genuinely unique rather than sequential, which is the opposite of
 * `uniquePhone` above and for a reason: a phone number has a format to fit
 * inside, and a state code has no length constraint anywhere in the repo. So
 * there is no need to gamble at all - not across workers, and not against the
 * rows a crashed run left behind.
 * ==========================================================================
 */
export function uniqueStateCode(): string {
  counter += 1
  return `Q${randomUUID().slice(0, 8)}${counter}`
}

/**
 * The one axe configuration for the whole suite.
 *
 * IT EXISTS BECAUSE THE TAG FILTER IS ITSELF A DEFECT SURFACE. Sixty call
 * sites across forty spec files each wrote
 * `.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])` by hand, and that
 * set EXCLUDES axe's `best-practice` rules — among them
 * `landmark-no-duplicate-main` and `landmark-main-is-top-level`. So
 * `/portal/pay/history` rendered a `<main>` inside the portal layout's
 * `<main>` — invalid HTML, two main landmarks, and the skip link's `#main`
 * resolving to the wrong one — and sixty axe scans passed over it (R-113).
 *
 * "axe passes" is a statement about a configuration, not about a page. One
 * helper means the next author cannot get the configuration wrong by copying
 * a neighbour, which is how all sixty came to be identical in the first place.
 *
 * `best-practice` is on. What that tag set adds beyond WCAG is landmark and
 * heading structure — exactly the class of defect this product was failing —
 * so nothing here is disabled. If a rule ever has to be turned off, it goes
 * in `disableRules` below WITH THE REASON, never by narrowing the tags back.
 */
export async function axeScan(
  page: import('@playwright/test').Page,
): Promise<import('axe-core').AxeResults> {
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze()
}
