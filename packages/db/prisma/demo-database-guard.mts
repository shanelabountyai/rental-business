// The refusal that keeps a demo seed off every database but the local
// `rental_demo` one.
//
// It lives here rather than in either seed because BOTH need it and only one
// had it. `seed-demo-access.mts` has refused since R-122, on the global
// convention's terms - "known-value demo credentials are fine when the seed
// that uses them refuses to run in production". `demo-seed.mts` had no guard
// at all, and `npm run db:seed:demo` carried `-e .env.local`, which on this
// machine is the Neon dev branch: the script named for the demo wrote the
// cloud, and its `--reset` deletes and retires rows there (R-137).
//
// It checks the database it is ACTUALLY POINTED AT rather than NODE_ENV,
// which is unset in half the ways either script can be run - so a forgotten
// or misordered `-e .env.demo` fails loudly here instead of succeeding
// somewhere it should never have reached.

export function refuseUnlessDemoDatabase(writes: string, howToRun: string): void {
  const url = process.env.DATABASE_URL ?? ''
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url)
  const isDemo = /\/rental_demo(\?|$)/.test(url)
  if (isLocal && isDemo) return

  // D-257: rent.labintelligence.co's production database is a demo database
  // on purpose. The override names the HOST it is allowed to write, exactly -
  // a boolean flag left in a shell would also have let the Neon dev branch
  // through, which is the R-137 accident this file exists to stop.
  const allowedHost = process.env.DEMO_SEED_ALLOW_HOST
  if (allowedHost) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      // An unparseable URL matches nothing and falls through to the refusal.
    }
    if (host === allowedHost) {
      console.warn(`\nDEMO_SEED_ALLOW_HOST matches: this script ${writes} on ${host}.\n`)
      return
    }
  }

  console.error(
    [
      '',
      `REFUSED. This script ${writes}, so it runs against the`,
      'local rental_demo database and nothing else.',
      '',
      `  DATABASE_URL names: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`,
      `  local: ${isLocal}   rental_demo: ${isDemo}`,
      '',
      `Run it as: ${howToRun}`,
      '',
    ].join('\n'),
  )
  process.exit(1)
}
