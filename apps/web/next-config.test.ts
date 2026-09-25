import { describe, expect, it } from 'vitest'
import nextConfig from './next.config.ts'

// K6/K7: the headers are config, so the only way to see them without a
// build is to ask the config. What they do on the wire is the browser's job.
describe('next.config headers', async () => {
  const rules = (await nextConfig.headers?.()) ?? []
  const forSource = (source: string) =>
    Object.fromEntries((rules.find((r) => r.source === source)?.headers ?? []).map((h) => [h.key, h.value]))

  it('sets the global security headers on every path', () => {
    const h = forSource('/:path*')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d+/)
    // SEC-08: never no-referrer, it breaks every no-JS form.
    expect(h['Referrer-Policy']).toBe('same-origin')
  })

  it('noindexes token paths and the calendar feed, but not the public listing', () => {
    for (const s of ['/pay/:path*', '/sign/:path*', '/vendor/:path*', '/api/calendar/:path*']) {
      expect(forSource(s)['X-Robots-Tag']).toContain('noindex')
    }
    expect(rules.some((r) => r.source.startsWith('/listings'))).toBe(false)
  })
})
