import { expect, test } from '@playwright/test'

// The cron endpoint runs every scheduled job in the product. Its authorization
// is therefore worth asserting from outside the process, over real HTTP, the
// way Vercel Cron and anyone scanning the deployment will meet it.

const CRON_PATH = '/api/cron'

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
    const secret = process.env.CRON_SECRET
    test.skip(!secret, 'CRON_SECRET is not set in this environment')

    const response = await request.get(CRON_PATH, {
      headers: { authorization: `Bearer ${secret!.slice(0, -1)}` },
    })
    expect(response.status()).toBe(404)
  })

  test('refuses a non-bearer authorization scheme', async ({ request }) => {
    const secret = process.env.CRON_SECRET
    test.skip(!secret, 'CRON_SECRET is not set in this environment')

    const response = await request.get(CRON_PATH, {
      headers: { authorization: `Basic ${secret}` },
    })
    expect(response.status()).toBe(404)
  })

  test('runs when the bearer token is right', async ({ request }) => {
    const secret = process.env.CRON_SECRET
    test.skip(!secret, 'CRON_SECRET is not set in this environment')

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
