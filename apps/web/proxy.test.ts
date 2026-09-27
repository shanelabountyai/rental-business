import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { config, proxy } from './proxy'

// The demo gate runs inside the proxy, so anything that lets a request skip
// the proxy skips the gate. A client chooses its own headers: the matcher must
// never key on them (it once did, for `Purpose: prefetch`).

afterEach(() => {
  delete process.env.DEMO_ACCESS_PASSWORD
})

describe('proxy', () => {
  it('matcher has no header-based exemption a client can send', () => {
    for (const entry of config.matcher) {
      expect('missing' in entry ? entry.missing : undefined).toBeUndefined()
    }
  })

  it.each<Record<string, string>>([
    { 'next-router-prefetch': '1' },
    { purpose: 'prefetch' },
  ])('still demands the gate password on a prefetch-shaped request %o', (headers) => {
    process.env.DEMO_ACCESS_PASSWORD = 'gate-check-9137'
    const res = proxy(new NextRequest('https://example.com/login', { headers }))
    expect(res.status).toBe(401)
  })
})
