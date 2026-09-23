import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from './route.ts'

// SEC-05 (D-262): the shared secret is read from the header only. Neither
// case reaches the database - the 403 is refused before parsing, and the
// header case stops at the 400 for an unparseable body.

const SECRET = 'test-inbound-email-secret-sec05'
let previousSecret: string | undefined

beforeAll(() => {
  previousSecret = process.env.INBOUND_EMAIL_SECRET
  process.env.INBOUND_EMAIL_SECRET = SECRET
})

afterAll(() => {
  if (previousSecret === undefined) delete process.env.INBOUND_EMAIL_SECRET
  else process.env.INBOUND_EMAIL_SECRET = previousSecret
})

describe('POST /api/email/inbound secret', () => {
  it('refuses the secret in the query string', async () => {
    const response = await POST(
      new Request(`http://localhost/api/email/inbound?secret=${SECRET}`, { method: 'POST', body: 'not json' }),
    )
    expect(response.status).toBe(403)
  })

  it('accepts the secret in the header', async () => {
    const response = await POST(
      new Request('http://localhost/api/email/inbound', {
        method: 'POST',
        headers: { 'x-inbound-secret': SECRET },
        body: 'not json',
      }),
    )
    expect(response.status).toBe(400)
  })
})
