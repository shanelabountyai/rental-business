import { describe, expect, it } from 'vitest'
import { STEP_UP_WINDOW_MS, stepUpIsFresh, stepUpReturnPath } from './step-up.ts'

describe('stepUpIsFresh', () => {
  const now = 1_800_000_000_000
  it('accepts a code inside the window, up to its edge', () => {
    expect(stepUpIsFresh(now - 1_000, now)).toBe(true)
    expect(stepUpIsFresh(now - STEP_UP_WINDOW_MS, now)).toBe(true)
  })
  it('refuses a stale, missing or future proof', () => {
    expect(stepUpIsFresh(now - STEP_UP_WINDOW_MS - 1, now)).toBe(false)
    expect(stepUpIsFresh(0, now)).toBe(false)
    expect(stepUpIsFresh(undefined, now)).toBe(false)
    expect(stepUpIsFresh(now + 60_000, now)).toBe(false)
  })
})

describe('stepUpReturnPath', () => {
  it('returns a path under the prefix, query included', () => {
    expect(stepUpReturnPath('/platform/account', '/platform')).toBe('/platform/account')
    expect(stepUpReturnPath('/platform/orgs/a?tab=1', '/platform')).toBe('/platform/orgs/a?tab=1')
    expect(stepUpReturnPath('/platform', '/platform')).toBe('/platform')
  })
  it('refuses anything that could leave the origin or the prefix', () => {
    for (const bad of [
      'https://evil.example/platform',
      '//evil.example/platform',
      '/\\evil.example',
      '/platformx',
      '/dashboard',
      'platform/account',
      '/platform/a b',
      null,
      undefined,
    ]) {
      expect(stepUpReturnPath(bad, '/platform'), String(bad)).toBe('/platform')
    }
  })
})
