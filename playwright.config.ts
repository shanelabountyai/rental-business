import { defineConfig, devices } from '@playwright/test'

// 3100, NOT 3000, and the default is the whole point.
//
// `reuseExistingServer` below means a server already listening on this port is
// used as-is. The sibling self-storage repo hardcodes `localhost:3000` and
// cannot be moved without editing its config, so a default of 3000 here meant
// that forgetting `PORT=3100` silently pointed THIS SUITE AT THAT APP - which
// fails in ways that make no sense, because the tests and the server disagree
// about what product they are. Documenting "PORT=3100 is not optional" made
// the footgun explainable rather than absent; owning a different port removes
// it. Still overridable, for the case where 3100 is itself taken.
const port = process.env.PORT ?? '3100'
const baseURL = `http://localhost:${port}`

/**
 * A fixed, fake Twilio auth token for the inbound-SMS webhook (R-021).
 *
 * Set for BOTH the dev server and this process so e2e/sms-webhook.spec.ts can
 * sign requests the route will accept. Without it the route correctly refuses
 * everything with 503, and the signature tests - the security-critical ones -
 * would all skip and the suite would look green having proved nothing.
 *
 * Not a secret: it authenticates nothing real, and the only thing it can
 * sign is a request to a local test server. It deliberately does not look
 * like a credential so nobody copies it anywhere.
 */
const TEST_TWILIO_AUTH_TOKEN = 'test-only-not-a-real-twilio-token'
process.env.TWILIO_AUTH_TOKEN ??= TEST_TWILIO_AUTH_TOKEN

/**
 * The same arrangement for Stripe's webhook endpoint (R-034, D-11).
 *
 * Set for BOTH the dev server and this process so e2e/stripe-webhook.spec.ts
 * can sign requests the route will accept. Without it the route correctly
 * refuses everything with a 400 - `no_secret` - and the refusal tests would
 * all "pass" having proved nothing, while the projection tests would fail
 * for a reason unrelated to what they check.
 *
 * Not a secret, and deliberately does not look like one: it authenticates
 * nothing real, and the only thing it can sign is a request to a local test
 * server.
 */
const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test-only-not-a-real-stripe-secret'
process.env.STRIPE_WEBHOOK_SECRET ??= TEST_STRIPE_WEBHOOK_SECRET

/**
 * And the same again for the inbound-email webhook (R-097a, COMM-08).
 *
 * That route takes a shared secret rather than a signature, and refuses
 * EVERYTHING with a 503 when the variable is unset - which is correct, and
 * which would let e2e/golden-path-4.spec.ts's whole email leg "pass" having
 * proved nothing, exactly as the Twilio one above would.
 *
 * INBOUND_EMAIL_ADDRESS is deliberately NOT set here. Setting it would put a
 * `Reply-To: hello+<key>@...` on every outbound email the suite sends, which
 * is a change to a surface dozens of other specs assert on - and the walk
 * wants the From:-matching path anyway, since that is the one a stranger
 * emailing us cold actually takes.
 *
 * Not a secret, and deliberately does not look like one.
 */
const TEST_INBOUND_EMAIL_SECRET = 'test-only-not-a-real-inbound-email-secret'
process.env.INBOUND_EMAIL_SECRET ??= TEST_INBOUND_EMAIL_SECRET

/**
 * And the cron endpoint's bearer token (R-133).
 *
 * `||=`, NOT `??=` like the three above, and the difference is the whole
 * reason this block exists. `.env.local` is written by `vercel env pull`, and
 * it carries `CRON_SECRET=""` - so unlike the three secrets above, this one is
 * not absent, it is present and EMPTY. `??=` would leave the empty string in
 * place and change nothing.
 *
 * An empty secret makes `isAuthorizedCron` refuse everything, which is correct
 * behaviour and a disaster for the spec: three of `e2e/cron.spec.ts`'s five
 * tests skip, and the two that remain assert a REFUSAL - so the whole file
 * passed against a gate that was answering `false` to every request on earth.
 * It would pass identically against `return false`. The endpoint runs every
 * scheduled job in the product, so that is the last gate worth proving by
 * accident.
 *
 * Not a secret, and deliberately does not look like one: it authenticates
 * nothing real, and the only thing it can open is a local test server.
 */
const TEST_CRON_SECRET = 'test-only-not-a-real-cron-secret'
process.env.CRON_SECRET ||= TEST_CRON_SECRET

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  /**
   * 60s, not Playwright's 30s default.
   *
   * The web server below is `npm run dev`, so Turbopack compiles each route
   * the first time anything asks for it. Under five parallel workers a cold
   * route can take most of a minute to come back, and the failure that
   * produces is deeply misleading: several tests in whichever file happened
   * to reach that route first all time out together on a locator for an
   * element that renders perfectly well, and every one of them passes when
   * re-run alone. It cost two debugging passes before the pattern was
   * readable.
   *
   * The alternative is building and serving production output for e2e,
   * which removes on-demand compilation entirely and would test what
   * actually ships - but it makes every local iteration pay a full build,
   * which is the wrong trade while this is the primary way the suite is run.
   * Worth revisiting the day this runs in CI, where the build happens anyway.
   */
  timeout: 60_000,
  /**
   * 15s per assertion, not Playwright's 5s default.
   *
   * The 5s default was the odd one out: a test allowed 60 seconds whose
   * individual assertions gave up at five. Every locator that waits on the
   * result of a `<form action>` is waiting on a server-action round trip, a
   * `revalidatePath`, and a full RSC re-render - and under two projects at
   * five workers that legitimately exceeds 5s without anything being wrong.
   * It surfaced as two flaky comms-threading tests that both passed on
   * retry, which is precisely the useless kind of failure: nothing to debug,
   * because nothing was broken.
   *
   * Deliberately not 60s. An assertion that will genuinely never pass should
   * still fail while somebody is watching.
   */
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  /**
   * One local retry, and a trace when it happens.
   *
   * NOT a way to make a red suite green. It is here because
   * `maintenance-phone-log.spec.ts` fails roughly one full run in three, in
   * whichever test reaches `/maintenance/new` first, timing out on a locator
   * for a `<select>` the page renders unconditionally - so the page did not
   * render at all. Ruled out so far: Turbopack cold-compile latency (it
   * still failed at a 60s timeout), and fixture collision on tenant phone
   * numbers (now unique per run). The remaining candidate is a transient
   * failure server-side under five workers against a pooled Neon
   * connection, which would 500 the page.
   *
   * `trace: 'on-first-retry'` below is the point: the next occurrence
   * records what the browser actually got, which is the one piece of
   * evidence three debugging passes have not had. A test that needs the
   * retry is still reported as flaky rather than passing quietly.
   */
  retries: process.env.CI ? 2 : 1,
  /**
   * `github` PLUS `html` in CI, and the html one is not a nicety.
   *
   * `.github/workflows/ci.yml` uploads `playwright-report/` on failure and
   * has done for months - but `github` is an annotation-only reporter that
   * writes NO FILES, so the directory never existed and `upload-artifact`
   * uploaded nothing. Measured: the three red runs that made D-171 an open
   * bug (33976436681, 33975060885, 33945215875) each carry `total_count: 0`
   * artifacts. `trace: 'on-first-retry'` below was recording exactly the
   * evidence D-171 said it did not have, into `test-results/`, and the
   * runner then threw it away.
   *
   * The html reporter copies each failure's trace into the report, so the
   * upload finally carries something. `open: 'never'` because nothing on a
   * runner can open a browser.
   */
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  // Tenant, tech and vendor surfaces are mobile-primary (master PRD 6.5), so
  // the default project is a phone viewport, not a desktop one.
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // A PRODUCTION BUILD, not `next dev`, and the reason is memory.
    //
    // `next dev` keeps the Turbopack compiler, the module graph, source maps
    // and HMR state resident for the whole run - measured at **1.9 GB** on
    // this machine. Five parallel Chrome workers are another ~490 MB each. On
    // a laptop already running other projects' dev servers that total pushes
    // the machine into swap, and macOS kills the largest process: the server.
    // Every test after that moment fails with ERR_CONNECTION_REFUSED in about
    // a second, which does not look like an environment problem - it looks
    // like fifty-five broken tests. That cost most of a session to diagnose.
    // `next start` on a prebuilt app holds a fraction of the memory and
    // serves faster, and it is also closer to what actually ships.
    //
    // `e2e:server` BUILDS THEN STARTS, so a stale or missing build cannot
    // silently test yesterday's code. Next's own cache makes the repeat build
    // cheap; `timeout` below covers a cold one.
    //
    // Set `E2E_DEV=1` to go back to `next dev` when you need a stack trace
    // against real sources or want the error overlay.
    //
    // `:test`, NEVER the bare script. The server under test has to read the
    // SAME database as the specs do, and `npm run dev`/`npm run start` load
    // only .env.local - which points at the deployed dev branch. Running the
    // two against different databases is a split brain that produces failures
    // nobody can reproduce: a spec seeds a tenant the app cannot see.
    command: process.env.E2E_DEV ? 'npm run dev:test' : 'npm run e2e:server',
    // AUTH_URL has to agree with the port, or Auth.js builds its post-sign-in
    // redirect against whatever .env.local says and the browser is sent to a
    // different origin than the one under test. dotenv-cli does not override
    // variables already present in the environment, so these win.
    env: {
      PORT: port,
      AUTH_URL: baseURL,
      // Same rule as vitest.config.ts: the e2e suite runs against the
      // SIMULATOR whatever is in .env.local. `npm run dev` would otherwise
      // pick up a real test key and every billing assertion would depend on
      // network and on somebody else's Stripe data.
      STRIPE_SECRET_KEY: '',
      // And the same for storage (R-100): the Blob token lands in .env.local
      // the moment anyone creates the store or runs `vercel env pull`, and
      // the seam selects durable storage on its presence alone. Without this
      // the e2e upload specs would write real objects into the production
      // Blob store. Dev and test are local disk by D-14.
      BLOB_READ_WRITE_TOKEN: '',
      // And the third instance of the same hazard (R-104). The notification
      // drivers select Resend and Twilio on the presence of their variables,
      // so a key in .env.local would make this suite send REAL EMAIL AND REAL
      // SMS - hundreds of them, at whatever NOTIFICATIONS_SANDBOX_TO names,
      // or at the fixture's invented address when it names nothing.
      // TWILIO_AUTH_TOKEN below is deliberately kept: it verifies the INBOUND
      // webhook's signature (R-021), and emptying the other two is enough
      // because the driver requires all three.
      RESEND_API_KEY: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_MESSAGING_SERVICE_SID: '',
      // Redirecting the recipient would also break every spec that asserts on
      // the address the log recorded.
      NOTIFICATIONS_SANDBOX_TO: '',
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? TEST_TWILIO_AUTH_TOKEN,
      STRIPE_WEBHOOK_SECRET:
        process.env.STRIPE_WEBHOOK_SECRET ?? TEST_STRIPE_WEBHOOK_SECRET,
      INBOUND_EMAIL_SECRET:
        process.env.INBOUND_EMAIL_SECRET ?? TEST_INBOUND_EMAIL_SECRET,
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // Covers a COLD `next build` plus start. 120s was sized for `next dev`,
    // which is ready in under a second and compiles lazily; a build from an
    // empty `.next` cache takes longer than that on its own.
    timeout: 300_000,
  },
})
