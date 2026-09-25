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
// boot failure in CI's e2e job. Check only what the app cannot run without.
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

const CHECKS: Check[] = [
  { name: 'DATABASE_URL', required: true, ok: (v) => /^postgres(ql)?:\/\//.test(v), want: 'a postgres:// URL' },
  { name: 'AUTH_SECRET', required: true, ok: (v) => v.length >= 16, want: 'at least 16 characters' },
  { name: 'DIRECT_URL', ok: (v) => /^postgres(ql)?:\/\//.test(v), want: 'a postgres:// URL' },
  { name: 'AUTH_URL', ok: isUrl, want: 'an absolute URL' },
  { name: 'NEXT_PUBLIC_APP_URL', ok: isUrl, want: 'an absolute URL' },
  { name: 'PORT', ok: (v) => /^\d{2,5}$/.test(v), want: 'a port number' },
]

/** Every problem with `env`, as sentences naming the variable. Empty means fine. */
export function envProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = []
  for (const { name, required, ok, want } of CHECKS) {
    const value = env[name]
    if (!value) {
      if (required) problems.push(`${name} is required and is not set.`)
    } else if (!ok(value)) {
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
