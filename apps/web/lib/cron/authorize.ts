import 'server-only'

import { timingSafeEqual } from 'node:crypto'

/**
 * Bearer token comparison, in constant time. Shared by every cron entry point
 * (R-029 added a second one, so this stopped being a route-local helper).
 *
 * Refuses everything when CRON_SECRET is unset - which .env.example already
 * demands. Defaulting to open would make a missing environment variable in a
 * new deployment into an unauthenticated endpoint that runs every scheduled
 * job in the product on request.
 */
export function isAuthorizedCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false

  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return false

  const provided = Buffer.from(header.slice('Bearer '.length))
  const secret = Buffer.from(expected)
  // Length is checked first because timingSafeEqual throws on a mismatch. The
  // length of a secret is not the secret.
  return provided.length === secret.length && timingSafeEqual(provided, secret)
}
