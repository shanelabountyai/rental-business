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

  it('marks every token path no-store and noindex (K6), including invite, final-export and reset-password', () => {
    const tokenPaths = [
      '/pay/:path*', '/sign/:path*', '/vendor/:path*', '/verify/:path*', '/apply/:path*',
      '/prescreen/:path*', '/clarify/:path*', '/showings/:path*', '/portal/:path*',
      '/invite/:path*', '/final-export/:path*', '/reset-password/:path*',
      '/api/calendar/:path*', '/api/final-export/:path*',
    ]
    for (const s of tokenPaths) {
      expect(forSource(s)['Cache-Control'], s).toMatch(/\bno-store\b/)
      expect(forSource(s)['X-Robots-Tag'], s).toContain('noindex')
    }
    // Never on the public, indexable pages.
    expect(forSource('/:path*')['Cache-Control']).toBeUndefined()
  })

  it('every [token] route directory under app/ is covered by a token-path rule', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const appDir = join(__dirname, 'app')
    const tokenRoutes: string[] = []
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (!statSync(full).isDirectory()) continue
        const next = entry.startsWith('(') ? rel : `${rel}/${entry}`
        if (entry === '[token]') tokenRoutes.push(next)
        walk(full, next)
      }
    }
    walk(appDir, '')
    expect(tokenRoutes.length).toBeGreaterThan(0)
    const covered = rules
      .filter((r) => r.headers.some((h) => h.key === 'Cache-Control'))
      .map((r) => r.source.replace('/:path*', ''))
    for (const route of tokenRoutes) {
      expect(covered.some((prefix) => route.startsWith(`${prefix}/`)), route).toBe(true)
    }
  })
})
