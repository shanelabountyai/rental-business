// The PWA manifest (D-8: "PWA over native for v1 - no app-store install wall,
// which is an activation killer; instant updates; magic-link deep linking").
//
// Served from a route rather than a static file so the start URL can follow
// AUTH_URL rather than being hardcoded to one deployment.
//
// Deliberately NOT a service worker. An installable, correctly-scoped
// manifest is what makes "add to home screen" work and is the whole of D-8's
// claim today; offline caching with a background sync queue is a genuinely
// different piece of work with its own failure modes, and R-028 owns it for
// the tech's job flow. Shipping an empty service worker now would claim
// offline support this build does not have.

export const dynamic = 'force-static'

export function GET() {
  const manifest = {
    name: 'Your home',
    short_name: 'Your home',
    description: 'Your home, your papers, and messages with your landlord.',
    // The portal, not the site root: a tenant who installs this expects to
    // land where they were, and / is the staff sign-in.
    start_url: '/portal',
    scope: '/portal',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    orientation: 'portrait-primary',
    icons: [
      // Inline SVG data URI rather than PNG files: this build has no brand
      // assets yet, and a manifest pointing at icons that 404 is worse than
      // one carrying a plain placeholder. Whoever adds real branding replaces
      // these two entries and nothing else.
      {
        src:
          'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="32" fill="#1f2937"/><path d="M96 44 36 96h18v52h34v-32h16v32h34V96h18z" fill="#fff"/></svg>',
          ),
        sizes: '192x192',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src:
          'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="86" fill="#1f2937"/><path d="M256 117 96 256h48v139h91v-85h42v85h91V256h48z" fill="#fff"/></svg>',
          ),
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  }

  return Response.json(manifest, {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}
