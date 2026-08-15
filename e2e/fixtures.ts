// Shared fixture helpers for the end-to-end suite.

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
