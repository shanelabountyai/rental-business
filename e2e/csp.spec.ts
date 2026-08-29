import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'

// The Content-Security-Policy (security review follow-on to D-137).
//
// ==========================================================================
// A CSP THAT IS NOT SENT LOOKS EXACTLY LIKE ONE THAT IS.
//
// Every other spec in this suite passed just as happily before the header
// existed, and would keep passing if the matcher in proxy.ts stopped
// matching - a regex with one character wrong silently protects nothing.
// So the header itself is asserted here, along with the two properties that
// make it worth having rather than merely present:
//
//   * it carries a NONCE and does not permit inline script, which is the
//     difference between a policy and a decoration;
//   * it does NOT reach the routes that serve document bytes, because
//     `documentResponse` sets a far stricter one there and a blanket page
//     policy would quietly replace the fix this file was written to back up.
// ==========================================================================

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test('a page is served with a nonce-based policy, not an inline-script one', async ({
  request,
}) => {
  // The sign-in page: unauthenticated, always rendered, and the one page an
  // attacker reaches without anything at all.
  const response = await request.get('/login')
  expect(response.status()).toBe(200)

  const csp = response.headers()['content-security-policy']
  expect(csp, 'every page response must carry a policy').toBeTruthy()

  // A NONCE, and a fresh one. Next stamps this onto its own inline hydration
  // scripts; without it the page renders script the header then refuses.
  expect(csp).toMatch(/script-src [^;]*'nonce-[a-f0-9]{32}'/)

  // THE ASSERTION THAT MAKES THE REST MEAN ANYTHING. `unsafe-inline` in
  // script-src permits exactly what a CSP exists to stop, and it is the
  // shortcut somebody reaches for the first time a page breaks.
  expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/)

  // The clickjacking and base-tag fences, which are one line each and guard
  // pages that end a tenancy or move money.
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("base-uri 'none'")
  expect(csp).toContain("form-action 'self'")
})

test('the nonce is per-request, not baked into the build', async ({ request }) => {
  const first = (await request.get('/login')).headers()['content-security-policy']
  const second = (await request.get('/login')).headers()['content-security-policy']
  expect(first).not.toBe(second)
})

test('Stripe is admitted deliberately and nothing else is', async ({ request }) => {
  const csp = (await request.get('/login')).headers()['content-security-policy']!

  // autopay-panel.tsx is the only third-party script in the product, and
  // Elements needs its frames and its API host as well as the script.
  expect(csp).toContain('https://js.stripe.com')
  expect(csp).toContain('https://api.stripe.com')
  expect(csp).toMatch(/frame-src [^;]*https:\/\/hooks\.stripe\.com/)

  // Nothing loads a web font here, so no font host may appear - an entry for
  // one is a permission granted to something that does not exist.
  expect(csp).toMatch(/font-src 'self'/)
  expect(csp).not.toContain('fonts.googleapis.com')
})

test('the page policy does not reach the routes that serve document bytes', async ({
  request,
}) => {
  // THE REGRESSION THIS FILE EXISTS FOR. `documentResponse` answers
  // `default-src 'none'; sandbox` for any type it will not render. If the
  // matcher ever stops excluding these paths, the proxy overwrites that
  // with the ordinary page policy - undoing the fix, silently, while every
  // other test stays green.
  //
  // Asserted against an id that does not exist: the route answers 404 before
  // it reads anything, and 404 is enough to prove which policy was applied,
  // without this spec having to own a document fixture.
  const response = await request.get('/api/documents/does-not-exist/file')
  expect(response.status()).toBe(404)
  const csp = response.headers()['content-security-policy']
  expect(csp ?? '', 'the page policy must not be applied under /api').not.toContain('nonce-')
})
