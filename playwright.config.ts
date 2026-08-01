import { defineConfig, devices } from '@playwright/test'

// `reuseExistingServer` below means a server already listening on this port is
// used as-is. That is the right default for local iteration, but the sibling
// self-storage repo also runs on 3000, and pointing this suite at that app
// wastes a debugging session. Overridable so both can run at once.
const port = process.env.PORT ?? '3000'
const baseURL = `http://localhost:${port}`

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
    env: { PORT: port },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
