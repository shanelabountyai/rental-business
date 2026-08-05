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
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
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
