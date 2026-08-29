import { NextResponse, type NextRequest } from 'next/server'

// A shared password in front of the whole site, for a deployment that is real
// but not meant to be seen yet. NOT the application's authentication - sign-in,
// roles and the tenant/staff split are all untouched behind it.
//
// The same gate the self-storage app runs, deliberately kept recognisable
// between the two so neither has to be re-read to understand the other.
//
// It lives here rather than in Vercel's Deployment Protection because that
// blocks inbound webhooks indiscriminately: enabling it would break Stripe,
// Resend and the SMS routes on go-live and force a bypass secret smuggled
// through a query parameter - which then changes the URL the provider signs.
//
// Unset `DEMO_ACCESS_PASSWORD` and this is inert, which is what local
// development, CI, the e2e suite and a genuinely public launch all want.
//
// THERE IS NO EXEMPTION LIST HERE, and that is a property of the caller rather
// than a difference of opinion with the storage app. `proxy.ts`'s matcher
// already excludes every `/api/` path - it has to, because those routes set
// their own far stricter CSP - so both crons, the Stripe and Resend webhooks
// and the three SMS/email routes never reach this function at all. If that
// matcher is ever broadened to cover `api/`, this file needs the storage app's
// GATE_EXEMPT list added to it in the same change, or seven inbound endpoints
// start answering 401 to providers that cannot authenticate any other way.

/// Length-independent comparison, so a wrong guess cannot be narrowed by timing
/// it. `crypto.timingSafeEqual` is Node-only and this runs on the edge runtime.
function passwordMatches(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/// Returns a 401 to send instead of handling the request, or null to carry on.
export function demoGate(request: NextRequest): NextResponse | null {
  const password = process.env.DEMO_ACCESS_PASSWORD
  if (!password) return null

  const header = request.headers.get('authorization')
  if (header?.startsWith('Basic ')) {
    // Basic rather than a login page and a cookie: the browser owns the prompt,
    // there is no form to build, no session to store and no CSRF surface - and
    // this is not protecting anything the app's own auth does not already
    // protect properly.
    let decoded = ''
    try {
      decoded = atob(header.slice('Basic '.length))
    } catch {
      // Malformed base64 is a failed attempt, not a crash.
    }
    // The username is ignored; anything will do. Split on the FIRST colon so a
    // password containing one survives.
    if (passwordMatches(decoded.slice(decoded.indexOf(':') + 1), password)) return null
  }

  return new NextResponse('Not available.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Demo", charset="UTF-8"',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
