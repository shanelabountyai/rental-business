import { describe, expect, it } from 'vitest'
import { isPlatformHost, platformRouteRefused } from './platform-host.ts'

const P = 'platform.localhost'

describe('platform host routing (PRD 11 §2.2)', () => {
  it('matches the hostname whatever the port or case, and nothing when unset', () => {
    expect(isPlatformHost('Platform.Localhost:3100', P)).toBe(true)
    expect(isPlatformHost('localhost:3100', P)).toBe(false)
    expect(isPlatformHost('evil.platform.localhost', P)).toBe(false)
    expect(isPlatformHost('platform.localhost', undefined)).toBe(false)
    expect(isPlatformHost('platform.localhost', '')).toBe(false)
  })

  it('serves the console only on its host', () => {
    expect(platformRouteRefused('localhost:3100', '/platform', P)).toBe(true)
    expect(platformRouteRefused('acme.localhost:3100', '/platform/login', P)).toBe(true)
    expect(platformRouteRefused('platform.localhost:3100', '/platform/login', P)).toBe(false)
    expect(platformRouteRefused('platform.localhost:3100', '/platform/api/auth/session', P)).toBe(false)
  })

  it('serves nothing but the console and / on the console host', () => {
    expect(platformRouteRefused('platform.localhost:3100', '/', P)).toBe(false)
    expect(platformRouteRefused('platform.localhost:3100', '/dashboard', P)).toBe(true)
    expect(platformRouteRefused('platform.localhost:3100', '/api/auth/session', P)).toBe(true)
    expect(platformRouteRefused('platform.localhost:3100', '/platformx', P)).toBe(true)
  })

  it('refuses every console path when PLATFORM_HOST is unset', () => {
    expect(platformRouteRefused('localhost:3100', '/platform/login', undefined)).toBe(true)
    expect(platformRouteRefused('localhost:3100', '/dashboard', undefined)).toBe(false)
  })
})
