import { afterEach, describe, expect, it, vi } from 'vitest'
import { refuseUnlessDemoDatabase } from './demo-database-guard.mts'

// The guard is the only thing between `db:seed:demo --reset` and whatever
// database it was handed. Until R-137 `db:seed:demo` carried `-e .env.local`,
// which on a developer machine is the Neon dev branch, and `demo-seed.mts` had
// no guard at all - so these cases are the ones that actually happened, not
// hypotheticals.

const NEON = 'postgresql://neondb_owner:hunter2@ep-gentle-cell-ayd8m0qg-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require'
const DEMO = 'postgresql://shane@localhost:5432/rental_demo'

function run(url: string | undefined) {
  const before = process.env.DATABASE_URL
  const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('exited')
  }) as never)
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    if (url === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = url
    let exited = false
    try {
      refuseUnlessDemoDatabase('writes demo data', 'npm run db:seed:demo')
    } catch {
      exited = true
    }
    return { exited, output: err.mock.calls.map((c) => String(c[0])).join('\n') }
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = before
    exit.mockRestore()
    err.mockRestore()
  }
}

afterEach(() => vi.restoreAllMocks())

describe('refuseUnlessDemoDatabase', () => {
  it('allows a local rental_demo', () => {
    expect(run(DEMO).exited).toBe(false)
  })

  it('allows a local rental_demo carrying query parameters', () => {
    expect(run(`${DEMO}?connection_limit=8`).exited).toBe(false)
  })

  it('refuses the Neon dev branch, which is what db:seed:demo used to be given', () => {
    const { exited, output } = run(NEON)
    expect(exited).toBe(true)
    expect(output).toContain('REFUSED')
  })

  // Both halves are load bearing and a single condition would pass one of
  // these while failing the other.
  it('refuses a remote database that IS named rental_demo', () => {
    expect(run('postgresql://u:p@db.example.com:5432/rental_demo').exited).toBe(true)
  })

  it('refuses a local database that is NOT rental_demo', () => {
    expect(run('postgresql://shane@localhost:5432/rental_test').exited).toBe(true)
  })

  // `rental_demo_backup` must not pass on a prefix match, and the suite's own
  // database must not pass because it merely contains the word.
  it('refuses a local database whose name only starts with rental_demo', () => {
    expect(run('postgresql://shane@localhost:5432/rental_demo_backup').exited).toBe(true)
  })

  it('refuses an unset DATABASE_URL rather than treating it as local', () => {
    const { exited, output } = run(undefined)
    expect(exited).toBe(true)
    expect(output).toContain('(unset)')
  })

  // The refusal prints the URL so you can see which database you were given.
  // It must not print the password while doing it.
  it('masks the password in the database it names', () => {
    const { output } = run(NEON)
    expect(output).toContain('neon.tech')
    expect(output).not.toContain('hunter2')
  })
})
