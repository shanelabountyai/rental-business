// The refusal that keeps the unit suite off a cloud database (K12).
//
// The convention is "tests never point at a remote database", and until now
// it held only because `npm test` loads `.env.test` through dotenv-cli - a
// forgotten `-e` or a bare `vitest` picks up `.env.local`, which on this
// machine is the Neon dev branch. Tests seed and delete rows, so that is a
// destructive run against shared data that looks like a slow one.
//
// Checks the URL the process is ACTUALLY holding, not NODE_ENV. An unset URL
// is allowed: a test that needs the database fails on its own, and a pure
// unit test has nothing to protect.

export function remoteTestDatabaseError(url: string | undefined): string | null {
  if (!url) return null
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return 'DATABASE_URL does not parse as a URL, so it cannot be shown to be local.'
  }
  if (host === 'localhost' || host === '127.0.0.1') return null
  return [
    `REFUSED: the test suite would run against ${host}, which is not local.`,
    'Tests seed and delete rows; run them through `npm test`, which loads .env.test',
    '(a local Postgres) ahead of .env.local.',
  ].join('\n')
}
