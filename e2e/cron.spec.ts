import { expect, test } from '@playwright/test'

// The cron endpoint runs every scheduled job in the product. Its authorization
// is therefore worth asserting from outside the process, over real HTTP, the
// way Vercel Cron and anyone scanning the deployment will meet it.

const CRON_PATH = '/api/cron'

// NO `test.skip` ON A MISSING SECRET, and that is the point of R-133.
//
// These three tests used to skip when `CRON_SECRET` was falsy - and it was
// falsy everywhere, because `.env.local` comes from `vercel env pull` and
// carries `CRON_SECRET=""`. That left the two unconditional tests below, both
// asserting a REFUSAL, which an empty secret produces for every request on
// earth: the file passed exactly as well against `return false` as against the
// real gate, on the authorization for every scheduled job in the product.
//
// `playwright.config.ts` now supplies a fake one, so the skips could never
// fire again. They are gone rather than left as reassurance: if that line is
// ever removed, these tests must go RED, not quietly green.
// The fallback is deliberately a wrong value rather than a `!` assertion: if
// the config ever stops supplying one, the last test below fails on a 404 it
// expected to be a 200, naming the problem, instead of skipping past it.
const secret = process.env.CRON_SECRET || 'no-cron-secret-in-this-environment'

test.describe('the cron endpoint', () => {
  // 404 rather than 401: an unauthenticated caller learns nothing about
  // whether this endpoint exists, and a scanner gets no signal to come back.
  test('refuses an unauthenticated request without admitting it exists', async ({
    request,
  }) => {
    const response = await request.get(CRON_PATH)
    expect(response.status()).toBe(404)
  })

  test('refuses a wrong bearer token', async ({ request }) => {
    const response = await request.get(CRON_PATH, {
      headers: { authorization: 'Bearer definitely-not-the-secret' },
    })
    expect(response.status()).toBe(404)
  })

  test('refuses a token that is merely a prefix of the real one', async ({
    request,
  }) => {
    const response = await request.get(CRON_PATH, {
      headers: { authorization: `Bearer ${secret.slice(0, -1)}` },
    })
    expect(response.status()).toBe(404)
  })

  test('refuses a non-bearer authorization scheme', async ({ request }) => {
    const response = await request.get(CRON_PATH, {
      headers: { authorization: `Basic ${secret}` },
    })
    expect(response.status()).toBe(404)
  })

  test('runs when the bearer token is right', async ({ request }) => {
    const response = await request.get(CRON_PATH, {
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(response.status()).toBe(200)

    // R-009 registered the first real job (unit auto-make-ready); this
    // asserts the runner reports cleanly against whatever properties exist,
    // not that any particular job did work - that is units.spec.ts's job.
    const body = await response.json()
    expect(body).toMatchObject({
      ok: true,
      failedJobs: 0,
    })
    expect(typeof body.durationMs).toBe('number')
  })
})
