import { describe, expect, it } from 'vitest'
import { assertEnv, envProblems } from './env.ts'

const good = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', AUTH_SECRET: 'x'.repeat(32) }

describe('envProblems', () => {
  it('passes the two required variables alone', () => {
    expect(envProblems(good)).toEqual([])
  })

  it('names a missing required variable', () => {
    expect(envProblems({ AUTH_SECRET: good.AUTH_SECRET })).toEqual(['DATABASE_URL is required and is not set.'])
  })

  it('treats an empty optional variable as unset, and an empty required one as missing', () => {
    expect(envProblems({ ...good, STRIPE_SECRET_KEY: '' })).toEqual([])
    expect(envProblems({ ...good, AUTH_SECRET: '' })).toHaveLength(1)
  })

  it('flags a malformed optional variable without printing its value', () => {
    const [problem] = envProblems({ ...good, STRIPE_SECRET_KEY: 'not-a-key-SECRETVALUE' })
    expect(problem).toContain('STRIPE_SECRET_KEY')
    expect(problem).not.toContain('SECRETVALUE')
  })

  it('assertEnv reports every problem at once', () => {
    expect(() => assertEnv({ AUTH_URL: 'nope' })).toThrow(/DATABASE_URL[\s\S]*AUTH_SECRET[\s\S]*AUTH_URL/)
  })
})
