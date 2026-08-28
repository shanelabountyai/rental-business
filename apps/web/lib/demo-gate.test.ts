import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { demoGate } from './demo-gate'

// Every bug this can have is silent in a different direction: a broken
// comparison lets the whole site through and looks like nothing at all, while
// an over-eager gate 401s a provider and looks like the provider's fault.

const PASSWORD = 'gate-check-9137'
const request = (path = '/') => new NextRequest(`https://example.com${path}`)

const withCredentials = (password: string) =>
  new NextRequest('https://example.com/', {
    headers: { authorization: `Basic ${btoa(`anyone:${password}`)}` },
  })

afterEach(() => {
  delete process.env.DEMO_ACCESS_PASSWORD
})

describe('demoGate', () => {
  it('is inert with no password set - local dev, CI, e2e and a public launch', () => {
    expect(demoGate(request())).toBeNull()
  })

  describe('with a password configured', () => {
    const configure = () => {
      process.env.DEMO_ACCESS_PASSWORD = PASSWORD
    }

    it('challenges with a 401 and a Basic realm', () => {
      configure()
      const response = demoGate(request())
      expect(response?.status).toBe(401)
      expect(response?.headers.get('WWW-Authenticate')).toContain('Basic')
    })

    it('tells crawlers not to index the challenge itself', () => {
      configure()
      expect(demoGate(request())?.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    })

    it('lets the right password through, whatever the username', () => {
      configure()
      expect(demoGate(withCredentials(PASSWORD))).toBeNull()
    })

    it('refuses the wrong password', () => {
      configure()
      expect(demoGate(withCredentials('wrong'))?.status).toBe(401)
    })

    it('refuses a password that is a prefix of the real one', () => {
      configure()
      expect(demoGate(withCredentials(PASSWORD.slice(0, -1)))?.status).toBe(401)
    })

    // Same length as the real one, deliberately: a shorter guess is rejected by
    // the length check before the comparison runs, so it proves nothing about
    // the comparison itself. This is the case that fails if `passwordMatches`
    // ever returns true unconditionally.
    it('refuses a wrong password of exactly the same length', () => {
      configure()
      const wrong = 'x'.repeat(PASSWORD.length)
      expect(wrong).toHaveLength(PASSWORD.length)
      expect(demoGate(withCredentials(wrong))?.status).toBe(401)
    })

    it('keeps a password that itself contains a colon', () => {
      process.env.DEMO_ACCESS_PASSWORD = 'a:b:c'
      const supplied = new NextRequest('https://example.com/', {
        headers: { authorization: `Basic ${btoa('demo:a:b:c')}` },
      })
      expect(demoGate(supplied)).toBeNull()
    })

    it('challenges when the header is missing entirely', () => {
      configure()
      expect(demoGate(request())?.status).toBe(401)
    })

    it('challenges a non-Basic scheme rather than trusting it', () => {
      configure()
      const bearer = new NextRequest('https://example.com/', {
        headers: { authorization: 'Bearer abc123' },
      })
      expect(demoGate(bearer)?.status).toBe(401)
    })

    it('treats malformed base64 as a failed attempt rather than crashing', () => {
      configure()
      const malformed = new NextRequest('https://example.com/', {
        headers: { authorization: 'Basic !!!not-base64!!!' },
      })
      expect(demoGate(malformed)?.status).toBe(401)
    })
  })
})
