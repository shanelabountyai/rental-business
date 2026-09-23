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
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'Referrer-Policy', value: 'same-origin' }] }]
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
