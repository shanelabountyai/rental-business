import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECKS, PLATFORM_SET, envProblems } from './env.ts'

// K11 (INV-14): every variable the app reads is validated at boot and named
// in .env.example. Static, like server-actions.test.ts: it scans the source
// for `process.env.NAME` and `env('NAME')`/`value('NAME')` reads, so a new
// variable fails here until it is added to CHECKS and .env.example.

const REPO = join(__dirname, '..', '..', '..')
const ROOTS = ['apps/web', 'packages'].map((d) => join(REPO, d))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return ['node_modules', '.next', 'generated'].includes(entry.name) ? [] : sourceFiles(path)
    }
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function namesRead(): Set<string> {
  const found = new Set<string>()
  const pattern =
    /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|\b(?:env|value)\(['"]([A-Z][A-Z0-9_]*)['"]\)/g
  for (const file of ROOTS.flatMap(sourceFiles)) {
    for (const m of readFileSync(file, 'utf8').matchAll(pattern)) found.add(m[1] ?? m[2] ?? m[3]!)
  }
  return found
}

describe('env coverage (K11)', () => {
  const read = namesRead()
  const checked = new Set(CHECKS.map((c) => c.name))
  const platform = new Set<string>(PLATFORM_SET)

  it('finds the variables it is meant to find', () => {
    for (const name of ['DATABASE_URL', 'CRON_SECRET', 'STRIPE_WEBHOOK_SECRET', 'RLS_ENFORCE']) {
      expect(read.has(name), name).toBe(true)
    }
  })

  it('every variable the code reads has a boot check (or is platform-set)', () => {
    expect([...read].filter((n) => !checked.has(n) && !platform.has(n)).sort()).toEqual([])
  })

  it('.env.example names every checked variable', () => {
    const example = readFileSync(join(REPO, '.env.example'), 'utf8')
    const listed = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!))
    expect([...checked].filter((n) => !listed.has(n)).sort()).toEqual([])
  })

  it('rejects a malformed secret or SID without printing it', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', AUTH_SECRET: 'x'.repeat(32) }
    const problems = envProblems({
      ...base,
      CRON_SECRET: 'has a SPACEVALUE',
      TWILIO_ACCOUNT_SID: 'notasid-SIDVALUE',
      RLS_ENFORCE: 'yes',
      ORG_BASE_DOMAIN: 'https://example.com/',
    })
    expect(problems.map((p) => p.split(' ')[0]).sort()).toEqual(
      ['CRON_SECRET', 'ORG_BASE_DOMAIN', 'RLS_ENFORCE', 'TWILIO_ACCOUNT_SID'],
    )
    expect(problems.join('\n')).not.toMatch(/SPACEVALUE|SIDVALUE/)
  })

  it('accepts the shapes the test harnesses and a real deployment use', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', AUTH_SECRET: 'x'.repeat(32) }
    expect(
      envProblems({
        ...base,
        CRON_SECRET: 'abcDEF123+/=\n',
        PLATFORM_HOST: 'platform.localhost',
        ORG_BASE_DOMAIN: 'orgs.localhost',
        RLS_ENFORCE: '1',
        TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
        TWILIO_MESSAGING_SERVICE_SID: `MG${'0'.repeat(32)}`,
        NOTIFICATIONS_SANDBOX_TO: 'dev@example.com, +15125550100',
        NEXT_PUBLIC_OPERATIONS_PHONE: '(512) 555-0100',
        RESEND_FROM: 'Rentals <notifications@example.com>',
        DEMO_ACCESS_PASSWORD: 'a passphrase with spaces',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'placeholder',
        NOTIFICATIONS_ENABLED: 'false',
      }),
    ).toEqual([])
  })
})
