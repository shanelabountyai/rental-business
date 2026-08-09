import { defineConfig, devices } from '@playwright/test'

// `reuseExistingServer` below means a server already listening on this port is
// used as-is. That is the right default for local iteration, but the sibling
// self-storage repo also runs on 3000, and pointing this suite at that app
// wastes a debugging session. Overridable so both can run at once.
const port = process.env.PORT ?? '3000'
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
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  // Tenant, tech and vendor surfaces are mobile-primary (master PRD 6.5), so
  // the default project is a phone viewport, not a desktop one.
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    // AUTH_URL has to agree with the port, or Auth.js builds its post-sign-in
    // redirect against whatever .env.local says and the browser is sent to a
    // different origin than the one under test. dotenv-cli does not override
    // variables already present in the environment, so these win.
    env: {
      PORT: port,
      AUTH_URL: baseURL,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? TEST_TWILIO_AUTH_TOKEN,
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
