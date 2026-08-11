import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors apps/web/tsconfig.json's "@/*" so tests can import app modules
      // the same way the app itself does, without maintaining relative paths.
      '@': fileURLToPath(new URL('./apps/web', import.meta.url)),
      // `server-only` is a build-time guard: it throws unless the importer is
      // resolved under Next's react-server condition. Under Vitest that would
      // make every server module untestable, so it maps to nothing here. The
      // guard still does its job in the real build, which is where a client
      // bundle could actually pull a secret in.
      'server-only': fileURLToPath(
        new URL('./packages/core/testing/empty.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Node by default - the tests this product actually demands (late-fee caps,
    // proration, RUBS allocation, days-past-due) are pure functions in
    // packages/core. Add jsdom + the React plugin when the first component
    // test shows up.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
    /**
     * THE SUITE ALWAYS RUNS AGAINST THE SIMULATOR, whatever is in .env.local.
     *
     * `getBillingProvider()` selects the real Stripe driver whenever
     * `STRIPE_SECRET_KEY` is set, and `npm test` loads `.env.local` through
     * dotenv-cli - so the day somebody adds a test key, every billing test
     * would silently start making real HTTP calls to Stripe. Slow, flaky,
     * dependent on network and on somebody else's test-mode data, and
     * different on one laptop than another.
     *
     * Emptied here rather than by adding an override flag to the selector,
     * because provider.ts argues correctly that "a code path that only runs
     * in one environment is a code path nothing has tested" - the fix belongs
     * in the test runner, not in the production decision. A test that wants
     * the real driver constructs `StripeBillingProvider` directly with a fake
     * key, which is exactly what stripe-adapter.test.ts already does.
     */
    env: { STRIPE_SECRET_KEY: '' },
  },
})
