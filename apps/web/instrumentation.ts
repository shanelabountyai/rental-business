// Runs once when the server boots (Next's instrumentation hook). Node only:
// the edge runtime has no process.env of the shape env.ts reads.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // `next build` also loads this with no runtime secrets in scope; the check
  // is for a server that is about to take requests.
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { assertEnv } = await import('./lib/env.ts')
  assertEnv()
}
