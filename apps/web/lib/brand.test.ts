import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { authUrl } from '@/lib/auth/delivery.ts'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { brandFor, brandStyle, PLATFORM_BRAND, usableColor } from '@/lib/brand.ts'

// R-289: brand as runtime data, and every link on the owning org's host.

const stamp = `brand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let orgB: string

beforeAll(async () => {
  orgB = (
    await prisma.organization.create({
      data: { slug: stamp, name: 'Bluebonnet Homes', colorAccent: '#1d4ed8', supportPhone: '(512) 555-0199' },
    })
  ).id
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await prisma.organization.delete({ where: { id: orgB } })
})

describe('usableColor', () => {
  it('keeps a hex colour that carries white text at AA', () => {
    expect(usableColor('#9a5b32')).toBe('#9a5b32') // Homestead copper, 5.36:1
  })
  it('drops a colour too light for white text, and anything that is not hex', () => {
    expect(usableColor('#f5d142')).toBeNull()
    expect(usableColor('red;}body{display:none')).toBeNull()
    expect(usableColor(null)).toBeNull()
  })
})

describe('brandStyle', () => {
  it('is empty for an unbranded org, so Homestead stands', () => {
    expect(brandStyle(PLATFORM_BRAND)).toEqual({})
  })
  it('overrides only the tokens the org set', async () => {
    expect(brandStyle(await brandFor(orgB))).toEqual({ '--accent': '#1d4ed8', '--accent-strong': '#1d4ed8' })
  })
})

describe('brandFor', () => {
  it("reads the org's own name and number", async () => {
    expect(await brandFor(orgB)).toMatchObject({ name: 'Bluebonnet Homes', supportPhone: '(512) 555-0199' })
  })
  it("never lends org #0's fallback number to another org", async () => {
    vi.stubEnv('NEXT_PUBLIC_OPERATIONS_PHONE', '+15125550100')
    await prisma.organization.update({ where: { id: orgB }, data: { supportPhone: null } })
    expect((await brandFor(orgB)).supportPhone).toBeNull()
    expect((await brandFor(DEFAULT_ORG_ID)).supportPhone).not.toBeNull()
  })
})

describe('authUrl', () => {
  it("puts another org's link on its own subdomain, keeping AUTH_URL's protocol and port", async () => {
    vi.stubEnv('AUTH_URL', 'http://localhost:3100')
    vi.stubEnv('ORG_BASE_DOMAIN', 'localhost')
    expect(await authUrl(orgB, '/portal')).toBe(`http://${stamp}.localhost:3100/portal`)
    expect(await authUrl(DEFAULT_ORG_ID, '/portal')).toBe('http://localhost:3100/portal')
  })
  it('leaves every link on AUTH_URL until the base domain exists (D-324)', async () => {
    vi.stubEnv('AUTH_URL', 'http://localhost:3100')
    vi.stubEnv('ORG_BASE_DOMAIN', '')
    expect(await authUrl(orgB, '/portal')).toBe('http://localhost:3100/portal')
  })
})
