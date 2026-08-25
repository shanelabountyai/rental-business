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
     *
     * `BLOB_READ_WRITE_TOKEN` is the same hazard arriving by a different
     * route, and it arrived on its own (R-100). Creating the Blob store makes
     * the Vercel CLI write the token straight into `.env.local` - nobody
     * chooses it - and the storage seam selects durable storage purely on its
     * presence. Every upload assertion in this suite would then write real
     * objects into the production Blob store, on somebody's quota, from
     * whichever laptop last ran `vercel env pull`. Emptied for the same reason
     * and by the same mechanism: D-14 chose local disk for dev and test
     * deliberately, and the test runner is where that gets enforced.
     *
     * THE NOTIFICATION PROVIDERS ARE THE THIRD INSTANCE, added by R-104 the
     * hour before the keys existed. `LiveChannelAdapter` selects Resend and
     * Twilio on the presence of their variables, exactly as the two seams
     * above select their real drivers - so the moment a key lands in
     * `.env.local`, this suite would start sending REAL EMAIL AND REAL SMS,
     * hundreds of them, to whatever `NOTIFICATIONS_SANDBOX_TO` names. That is
     * worse than the Blob case: it reaches a person's inbox and phone, and
     * on a laptop with no sandbox address set it reaches whatever address the
     * fixture invented. `TWILIO_AUTH_TOKEN` is deliberately NOT emptied - it
     * verifies the signature on the INBOUND webhook (R-021) and the suite
     * needs it - and emptying the other two Twilio values is enough, because
     * the driver requires all three. `NOTIFICATIONS_SANDBOX_TO` goes too: it
     * rewrites the recipient the log records, and specs assert on that
     * address.
     */
    env: {
      STRIPE_SECRET_KEY: '',
      BLOB_READ_WRITE_TOKEN: '',
      RESEND_API_KEY: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_MESSAGING_SERVICE_SID: '',
      NOTIFICATIONS_SANDBOX_TO: '',
    },
    /**
     * 20s, not Vitest's 5s default.
     *
     * That default is sized for pure unit tests. Most of this suite is
     * INTEGRATION against a real Neon Postgres over the network, and the full
     * run puts several files through it in parallel - so a test that takes
     * 400ms alone can take eight seconds under load. The symptom is the worst
     * kind: a handful of unrelated tests time out on a different file each
     * run, all of them passing when re-run alone, and the suite looks flaky
     * when nothing is wrong.
     *
     * This replaces a growing pile of per-test timeout arguments, several of
     * which were added one failure at a time. The genuinely long-running
     * tests keep their explicit values and their stated reasons.
     *
     * Deliberately not higher. A test that will never pass should still fail
     * while somebody is watching.
     */
    testTimeout: 20_000,
  },
})
