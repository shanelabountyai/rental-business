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
  { name: 'STRIPE_SECRET_KEY', ok: (v) => /^(sk|rk)_/.test(v), want: 'a key starting sk_ or rk_' },
  { name: 'STRIPE_WEBHOOK_SECRET', ok: (v) => v.startsWith('whsec_'), want: 'a secret starting whsec_' },
  { name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', ok: (v) => v.startsWith('pk_'), want: 'a key starting pk_' },
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
