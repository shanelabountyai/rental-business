import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isAuthorizedCron } from './authorize.ts'

// THE GATE ON EVERY SCHEDULED JOB IN THE PRODUCT, and until R-133 nothing had
// ever executed it. `e2e/cron.spec.ts` covers it over real HTTP, but three of
// its five tests skip when `CRON_SECRET` is empty - and it IS empty, on this
// laptop and in CI both, because `.env.local` comes from `vercel env pull` and
// carries `CRON_SECRET=""`. Worse, the two that DO run assert a refusal, and an
// empty secret makes `isAuthorizedCron` refuse everything: the file passed
// identically against `return false`. `playwright.config.ts` now supplies a
// fake one so those three stop skipping.
//
// This half is the durable one: a unit test does not care what the environment
// happens to hold, and it reaches the two branches HTTP cannot show apart - a
// wrong-length token is a refusal here and a 404 there, the same 404 a correct
// refusal produces.

const SECRET = 'a-secret-of-known-length'

function get(authorization?: string): Request {
  return new Request('https://example.test/api/cron', {
    headers: authorization ? { authorization } : {},
  })
}

// Cleared BEFORE as well as after, so the unset case asserts the unset case
// wherever this runs. Vitest is loaded through the same `.env` files the app
// is, so without this the first test below would read an ambient secret and
// pass for the wrong reason.
beforeEach(() => {
  delete process.env.CRON_SECRET
})

afterEach(() => {
  delete process.env.CRON_SECRET
})

describe('isAuthorizedCron', () => {
  it('refuses everything when CRON_SECRET is unset, including the right token', () => {
    // Fail CLOSED. A missing variable in a new deployment must not open an
    // endpoint that runs every scheduled job on request.
    expect(isAuthorizedCron(get(`Bearer ${SECRET}`))).toBe(false)
  })

  it('accepts the exact token', () => {
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get(`Bearer ${SECRET}`))).toBe(true)
  })

  it('refuses a token that is a prefix of the real one', () => {
    // The length check exists because `timingSafeEqual` THROWS on a length
    // mismatch; without it this input is a 500 rather than a refusal.
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get(`Bearer ${SECRET.slice(0, -1)}`))).toBe(false)
  })

  it('refuses a token longer than the real one', () => {
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get(`Bearer ${SECRET}x`))).toBe(false)
  })

  it('refuses the right secret under a non-bearer scheme', () => {
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get(`Basic ${SECRET}`))).toBe(false)
  })

  it('refuses a 7-character scheme, which is the only one that tests the check', () => {
    // `Digest ` is exactly as long as `Bearer `, and that is the entire point.
    // Deleting the startsWith() guard leaves `header.slice('Bearer '.length)`,
    // which for ANY OTHER scheme slices the wrong number of characters and
    // mangles the token into a refusal for the wrong reason - so every other
    // scheme passes with the guard gone. Mutating the guard away while writing
    // this file kept all seven tests green; this input is what turns it red,
    // and without it the scheme check is untested code that looks tested.
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get(`Digest ${SECRET}`))).toBe(false)
  })

  it('refuses a request with no authorization header at all', () => {
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get())).toBe(false)
  })

  it('refuses a bare token with no scheme', () => {
    process.env.CRON_SECRET = SECRET
    expect(isAuthorizedCron(get(SECRET))).toBe(false)
  })
})
