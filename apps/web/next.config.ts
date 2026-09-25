import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not a build step.
  transpilePackages: ['@rental/db', '@rental/core'],
  // A build typechecks the app, not the test suite that exercises it
  // (R-120). tsconfig.build.json says why, and the reason is a two-day
  // outage rather than a preference.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  // Bearer tokens live in URL PATHS here - /pay, /sign, /vendor, /verify,
  // /api/calendar - so a Referer is a copy of the credential (SEC-06).
  // Set here rather than in proxy.ts because the proxy deliberately skips
  // /api and the document-byte routes, and both carry tokens. No code in
  // this app reads Referer; Server Actions check Origin.
  // `same-origin`, NEVER `no-referrer` (SEC-08): under `no-referrer` a
  // browser sends `Origin: null` on a native form POST, Next's action CSRF
  // check refuses it ("Invalid Server Actions request"), and every
  // no-JavaScript form in the product stops working. `same-origin` still
  // sends nothing to another site, which is all SEC-06 needed.
  //
  // Everything else a scanner asks of "global" (K7) lives here for the same
  // reason - the proxy skips /api and the document routes, so a header that
  // must cover them cannot be set there. HSTS and nosniff are safe on every
  // response; `frame-ancestors 'none'` stays with the page CSP in proxy.ts,
  // and X-Frame-Options DENY is its header-level twin for the routes the
  // proxy does not run on.
  //
  // NOINDEX covers the token paths as a header, not just page metadata,
  // because /api/calendar and the document-byte routes have no metadata to
  // carry it. The hosted listing (/listings) is public and indexable ON
  // PURPOSE and is deliberately not in this list.
  async headers() {
    const NOINDEX = [
      'pay', 'sign', 'vendor', 'verify', 'apply', 'prescreen', 'clarify', 'showings', 'portal',
    ].map((segment) => `/${segment}/:path*`)
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
      ...[...NOINDEX, '/api/calendar/:path*'].map((source) => ({
        source,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
    ]
  },
  experimental: {
    // Next caps a Server Action body at 1 MB by default, and every photo
    // upload in this product goes through one - inspections, notice service,
    // abandonment entries, violation observations, and now loss photographs.
    // A photo off a phone is routinely 2-5 MB, so the default was rejecting
    // the exact evidence those flows exist to capture, with an error that
    // reads as a server fault rather than a size limit. Raised here rather
    // than per-route because it is one shared ceiling and every caller wants
    // the same answer.
    //
    // 25 MB also admits a short walkthrough video, which RISK-07 asks for.
    // It is NOT enough for a long one: a real video path wants a
    // direct-to-storage upload that bypasses the action body entirely, and
    // nothing owns that yet.
    serverActions: { bodySizeLimit: '25mb' },
  },
}

export default nextConfig
