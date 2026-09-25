import type { NextRequest } from 'next/server'
import { redeemMagicLink } from '@/lib/auth/redeem-magic-link.ts'

export const runtime = 'nodejs'

export const POST = (request: NextRequest) =>
  redeemMagicLink(request, {
    provider: 'tenant-magic-link',
    destination: '/portal',
    loginPath: '/portal/login',
  })
