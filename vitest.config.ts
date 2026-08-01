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
  },
})
