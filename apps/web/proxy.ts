import { type NextRequest, NextResponse } from 'next/server'

import { demoGate } from '@/lib/demo-gate'

// The Content-Security-Policy (security review follow-on to D-137).
//
// ==========================================================================
// THE DEFENCE THAT WOULD HAVE CONTAINED D-137, ADDED AFTER IT RATHER THAN
// INSTEAD OF FIXING IT.
//
// D-137 was a stored XSS: an uploaded `image/svg+xml` served inline ran in
// this origin with the viewer's session. That is closed at its source - the
// bytes are retyped now - and this is the second fence, for the injection
// nobody has found yet.
//
// A NONCE, NOT `unsafe-inline`. Next's App Router inlines its own hydration
// and streaming scripts on every page, so a policy without a nonce has to
// allow inline script wholesale - which permits precisely the thing a CSP
// exists to stop, and would have made this file theatre. The nonce is
// minted per request here and Next stamps it onto its own inline scripts by
// reading the CSP off the request headers below.
//
// WHAT IT COSTS, named rather than discovered later: a per-request nonce
// means a page carrying one cannot be statically generated, because its HTML
// differs every time. Nearly every page in this product is behind a session
// and already dynamic, so the loss is small - but it is real, and a future
// item that wants a page prerendered has to reckon with this file.
//
// MEASURED, NOT GUESSED, which is the whole reason this was not bundled into
// the item that found D-137: a policy written from a list of what an app
// *probably* loads is one somebody switches off the first time a page breaks.
// The 1006-test e2e suite drives essentially every screen, so enforcing the
// policy and running the sweep IS the measurement - a better one than a
// report-only header nobody reads.
// ==========================================================================

/**
 * Everything this app actually loads, and nothing else.
 *
 * The inventory behind each non-obvious entry:
 *
 *   * `js.stripe.com` / `hooks.stripe.com` - `autopay-panel.tsx` is the only
 *     third-party script in the product. `loadStripe()` injects Stripe.js,
 *     which then opens Elements in its own iframes; §6.6 keeps card data
 *     inside those frames and out of this document, so `frame-src` is
 *     load-bearing rather than cosmetic.
 *   * `api.stripe.com` in `connect-src` - Elements talks to it directly.
 *   * `data:` and `blob:` in `img-src` - inspection and listing photos are
 *     previewed from a local object URL before they are ever uploaded.
 *   * NO font host. Nothing here loads a web font, and an entry for one
 *     would be a permission granted to something that does not exist.
 *
 * `style-src` keeps `'unsafe-inline'`, and that is a deliberate, bounded
 * concession rather than an oversight: React and Stripe both set inline
 * styles, nonce-ing every one of them is a large change to component code,
 * and inline STYLE cannot execute script - the worst it buys an attacker is
 * defacement, against a `script-src` that still refuses to run anything.
 *
 * `'strict-dynamic'` is paired with the Stripe host on purpose: a browser
 * that understands it ignores host allowlists and trusts what an
 * already-trusted script loads (which is exactly how Stripe.js and Next's
 * own chunks arrive), while an older browser falls back to the host entry.
 */
function policy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https://api.stripe.com",
    'frame-src https://js.stripe.com https://hooks.stripe.com',
    // Nobody may frame this app. Clickjacking a page that ends a tenancy or
    // moves money is worth the one line.
    "frame-ancestors 'none'",
    // An injected <base> would silently repoint every relative URL on the
    // page, including the ones a form posts to.
    "base-uri 'none'",
    // Forms post here and nowhere else, so an injected form cannot exfiltrate
    // what somebody types into it.
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

// Next 16 renamed this file convention from `middleware` to `proxy`, and
// the export with it: the build reads `mod.proxy || mod.default` for a proxy
// file. Everything below - the matcher, the nonce, the request header Next
// stamps its inline scripts from - is unchanged by the rename.
export function proxy(request: NextRequest) {
  // Before the nonce work: a visitor who is not past the demo gate should cost
  // a 401 and nothing else, not a minted nonce and a policy they never see.
  // Only active when DEMO_ACCESS_PASSWORD is set, so local dev, CI and the e2e
  // suite are untouched.
  const locked = demoGate(request)
  if (locked) return locked

  const nonce = crypto.randomUUID().replace(/-/g, '')
  const csp = policy(nonce)

  // Set on the REQUEST as well as the response: this is how Next finds the
  // nonce to stamp onto its own inline scripts. Without the request header
  // the page renders unnonced script that the response header then refuses,
  // and every page is blank.
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    /*
     * Page navigations only.
     *
     * `api/` is excluded because those responses are JSON or BYTES, and one
     * of them sets its OWN, far stricter policy: `documentResponse` answers
     * `default-src 'none'; sandbox` for any content type it will not render.
     * A blanket page policy applied here would REPLACE that with a weaker
     * one - the proxy would quietly undo the fix it was written to back
     * up. The three non-`api` routes that also serve document bytes are
     * excluded by name for exactly the same reason.
     *
     * `_next/static` and `_next/image` are build output and image
     * optimisation; running the proxy on them costs a function invocation
     * per asset and buys nothing, since neither is a document a script can
     * live in.
     */
    {
      source:
        '/((?!api/|_next/static|_next/image|favicon.ico|listings/[^/]+/photos/|sign/[^/]+/document|vendor/[^/]+/documents/).*)',
      missing: [
        // Not on prefetches and client-side navigations: those return RSC
        // payloads rather than a document, so there is nothing to nonce.
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
