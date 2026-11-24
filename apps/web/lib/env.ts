// Boot-time check of the environment (K11).
//
// Deliberately NOT a schema library: a table of names and one predicate each
// is the whole need, and the repo carries no validator dependency.
//
// Two things are REQUIRED, because the app cannot run without them:
// DATABASE_URL and AUTH_SECRET. Everything else is optional by design - an
// unset CRON_SECRET or INBOUND_EMAIL_SECRET fails closed at its own route, and
// unset provider keys select the simulator - so making them required here
// would turn a supported state into an outage. What this DOES catch is a
// variable that is set and malformed, which today surfaces as a confusing
// failure deep inside whichever request reads it first.
//
// The Stripe keys are deliberately NOT shape-checked. CI writes
// NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY from a secret that may be absent or a
// placeholder, and the app treats any non-key as "no Stripe" (`?? null`, then
// the simulator) - so a `pk_` check turned a supported degraded state into a
// boot failure in CI's e2e job. They are still LISTED below (K11), with a check
// that accepts any value, so the coverage test can prove nothing is unread.
//
// An empty string counts as unset: vitest.config blanks the provider keys
// that way, and a `NAME=` line in .env.example means "not filled in yet".

type Check = { name: string; required?: boolean; ok: (v: string) => boolean; want: string }

const isUrl = (v: string) => {
  try {
    new URL(v)
    return true
  } catch {
    return false
  }
}

const noSpace = (v: string) => /^\S+$/.test(v)
const anyValue = () => true
const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
const isPhone = (v: string) => /^\+?[0-9 ().-]{7,24}$/.test(v) && (v.match(/[0-9]/g)?.length ?? 0) >= 7
// A bare host, as the org/platform host checks compare it: no scheme, no path.
const isHost = (v: string) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?$/i.test(v)
const SECRET = 'a single token with no whitespace'

/// EVERY variable the app reads (K11, INV-14). `env-coverage.test.ts` fails if
/// code reads a name that is neither here nor in PLATFORM_SET, and if
/// `.env.example` misses one. A check that accepts anything (`anyValue`) is a
/// deliberate "listed, not shape-checked" - each says why.
export const CHECKS: Check[] = [
  { name: 'DATABASE_URL', required: true, ok: (v) => /^postgres(ql)?:\/\//.test(v), want: 'a postgres:// URL' },
  { name: 'AUTH_SECRET', required: true, ok: (v) => v.length >= 16, want: 'at least 16 characters' },
  { name: 'DIRECT_URL', ok: (v) => /^postgres(ql)?:\/\//.test(v), want: 'a postgres:// URL' },
  { name: 'AUTH_URL', ok: isUrl, want: 'an absolute URL' },
  { name: 'NEXT_PUBLIC_APP_URL', ok: isUrl, want: 'an absolute URL' },
  { name: 'PORT', ok: (v) => /^\d{2,5}$/.test(v), want: 'a port number' },
  // Bearer / shared secrets. Unset fails closed at the route; set-with-a-space
  // can never match the header it is compared against.
  { name: 'CRON_SECRET', ok: noSpace, want: SECRET },
  { name: 'INBOUND_EMAIL_SECRET', ok: noSpace, want: SECRET },
  { name: 'RESEND_WEBHOOK_SECRET', ok: noSpace, want: SECRET },
  { name: 'RESEND_API_KEY', ok: noSpace, want: SECRET },
  { name: 'TWILIO_AUTH_TOKEN', ok: noSpace, want: SECRET },
  { name: 'BLOB_READ_WRITE_TOKEN', ok: noSpace, want: SECRET },
  { name: 'DEMO_ACCESS_PASSWORD', ok: anyValue, want: 'any value (a passphrase may contain spaces)' },
  // Stripe: listed, NOT shape-checked - see the header (CI's placeholder key).
  { name: 'STRIPE_SECRET_KEY', ok: anyValue, want: 'any value' },
  { name: 'STRIPE_PUBLISHABLE_KEY', ok: anyValue, want: 'any value' },
  { name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', ok: anyValue, want: 'any value' },
  { name: 'STRIPE_WEBHOOK_SECRET', ok: anyValue, want: 'any value' },
  { name: 'STRIPE_CONNECT_WEBHOOK_SECRET', ok: anyValue, want: 'any value' },
  { name: 'STRIPE_SMOKE_KEY', ok: anyValue, want: 'any value' },
  // Twilio SIDs have fixed prefixes; anything else is rejected by Twilio anyway.
  { name: 'TWILIO_ACCOUNT_SID', ok: (v) => /^AC[0-9a-f]{32}$/i.test(v), want: 'an AC... account SID' },
  { name: 'TWILIO_MESSAGING_SERVICE_SID', ok: (v) => /^MG[0-9a-f]{32}$/i.test(v), want: 'an MG... messaging service SID' },
  // Addresses and hosts.
  { name: 'RESEND_FROM', ok: (v) => v.includes('@'), want: 'an email address' },
  { name: 'RESEND_SHARED_FROM', ok: (v) => v.includes('@'), want: 'an email address' },
  { name: 'INBOUND_EMAIL_ADDRESS', ok: isEmail, want: 'an email address' },
  {
    name: 'NOTIFICATIONS_SANDBOX_TO',
    ok: (v) => v.split(',').map((a) => a.trim()).filter(Boolean).every((a) => isEmail(a) || isPhone(a)),
    want: 'comma-separated email addresses or phone numbers',
  },
  { name: 'NEXT_PUBLIC_OPERATIONS_PHONE', ok: isPhone, want: 'a phone number' },
  { name: 'ORG_BASE_DOMAIN', ok: isHost, want: 'a bare host name (no scheme or path)' },
  { name: 'PLATFORM_HOST', ok: isHost, want: 'a bare host name (no scheme or path)' },
  { name: 'DEMO_SEED_ALLOW_HOST', ok: isHost, want: 'a bare host name (no scheme or path)' },
  // Flags. NOTIFICATIONS_ENABLED is documented as "anything but the exact
  // string false leaves sending on", so it is listed, not narrowed.
  { name: 'NOTIFICATIONS_ENABLED', ok: anyValue, want: 'any value' },
  { name: 'RLS_ENFORCE', ok: (v) => v === '0' || v === '1', want: '0 or 1' },
  { name: 'DOCUMENT_STORAGE_PATH', ok: anyValue, want: 'a filesystem path' },
]

/// Set by the platform or the runtime, never by us: listed so the coverage
/// test can tell "forgotten" from "not ours".
export const PLATFORM_SET = [
  'NODE_ENV', 'NEXT_PHASE', 'NEXT_RUNTIME', 'TZ', 'VERCEL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA',
] as const

/** Every problem with `env`, as sentences naming the variable. Empty means fine. */
export function envProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = []
  for (const { name, required, ok, want } of CHECKS) {
    const value = env[name]
    if (!value) {
      if (required) problems.push(`${name} is required and is not set.`)
    } else if (!ok(value.trim())) {
      // Trimmed first: the provider drivers trim what they read, and a pasted
      // value with a trailing newline must not become a boot failure.
      // The value is never printed: a malformed secret is still a secret.
      problems.push(`${name} is set but is not ${want}.`)
    }
  }
  return problems
}

/** Throws, naming every bad variable at once, so one boot shows the whole list. */
export function assertEnv(env: Record<string, string | undefined> = process.env): void {
  const problems = envProblems(env)
  if (problems.length) throw new Error(`Invalid environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
}
