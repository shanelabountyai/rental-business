import 'server-only'

import { prisma } from '@rental/db'
import { cache } from 'react'

import { DEFAULT_ORG_ID, hostOrgId } from '@/lib/auth/org.ts'

// Brand as runtime data (R-289, PRD 10 §4): the org the host names supplies
// its name, two colours and a support contact. A palette swap over the
// Homestead tokens (D-163), not a theme engine.

export type Brand = {
  name: string
  colorPrimary: string | null
  colorAccent: string | null
  supportPhone: string | null
  supportEmail: string | null
}

/// The bare base host and an unknown slug name no org (D-344). They get the
/// product's own neutral name and no support contact.
export const PLATFORM_BRAND: Brand = {
  name: 'Rental Operations',
  colorPrimary: null,
  colorAccent: null,
  supportPhone: null,
  supportEmail: null,
}

export async function brandFor(orgId: string): Promise<Brand> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, colorPrimary: true, colorAccent: true, supportPhone: true, supportEmail: true },
  })
  if (!org) return PLATFORM_BRAND
  // ponytail: org #0 keeps reading NEXT_PUBLIC_OPERATIONS_PHONE when its row
  // has no number, so the deployed demo keeps its help line with no data
  // step. Retire the variable once org #0's row carries the number.
  const fallback = orgId === DEFAULT_ORG_ID ? process.env.NEXT_PUBLIC_OPERATIONS_PHONE?.trim() : undefined
  return { ...org, supportPhone: org.supportPhone ?? (fallback || null) }
}

/// The brand of the org this request's host names. Cached per request.
export const currentBrand = cache(async (): Promise<Brand> => {
  const orgId = await hostOrgId()
  return orgId ? brandFor(orgId) : PLATFORM_BRAND
})

/// WCAG relative luminance of `#rrggbb`.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// A colour is used only if it is a plain hex colour AND carries white text at
/// AA (4.5:1) - both tokens sit behind white button text and the accent is
/// also link text on white, so one ratio covers every use. A colour that fails
/// falls back to Homestead rather than shipping an unreadable button: the
/// brand is data an org types, and WCAG AA is an acceptance criterion here.
export function usableColor(hex: string | null): string | null {
  if (!hex || !/^#[0-9a-f]{6}$/.test(hex)) return null
  return 1.05 / (luminance(hex) + 0.05) >= 4.5 ? hex : null
}

/// The CSS custom properties that override Homestead for this brand, for the
/// `style` of `<html>`. Empty for an unbranded org.
export function brandStyle(brand: Brand): Record<string, string> {
  const style: Record<string, string> = {}
  const primary = usableColor(brand.colorPrimary)
  const accent = usableColor(brand.colorAccent)
  if (primary) style['--primary'] = primary
  if (accent) {
    style['--accent'] = accent
    style['--accent-strong'] = accent
  }
  return style
}
