import 'server-only'

import { checkToken, hashToken } from '@rental/core/auth'
import { prisma } from '@rental/db'

// Reading a SHOWING_BOOKING link (LEASE-08, R-064) - the non-consuming
// half, same split apps/web/lib/prospects/prescreen-link.ts's own
// `prescreenLinkStatus()` uses: a GET renders the slot picker and must not
// burn the token merely by being opened, so the page and the booking action
// both call this, and only the booking action goes on to redeem it.

export type ShowingLinkResult =
  | {
      ok: true
      prospectId: string
      firstName: string
      propertyId: string
      addressLine1: string
      unitId: string
      unitName: string
      unitStatus: string
      timezone: string
      state: string
      county: string | null
    }
  | {
      ok: false
      reason: string
      /// Set when the reason is `already_used` and a real booking exists -
      /// the page's own confirmation once the token is burned, same fix
      /// `/sign/[token]`'s page comment documents for the identical trap: a
      /// Server Action always triggers a refresh of the page that called
      /// it, so this rejected branch is the ONLY one a booking prospect
      /// ever actually sees painted.
      booked?: {
        scheduledStart: Date
        unitName: string
        addressLine1: string
        timezone: string
        /// R-094. Without this the confirmation below promises an escort for
        /// a viewing nobody is going to attend - the same promise the
        /// `showing.scheduled` template was making.
        selfService: boolean
      }
    }

export async function showingLinkStatus(rawToken: string): Promise<ShowingLinkResult> {
  const tokenHash = hashToken(rawToken)
  const stored = await prisma.authToken.findUnique({ where: { tokenHash } })

  const verdict = checkToken(stored, { purpose: 'SHOWING_BOOKING', subjectType: 'Prospect' })
  if (!verdict.ok) {
    if (verdict.reason === 'already_used' && stored) {
      const showing = await prisma.showing.findFirst({
        where: { prospectId: stored.subjectId, status: 'BOOKED' },
        orderBy: { createdAt: 'desc' },
        include: {
          unit: { select: { name: true, status: true, smartLock: { select: { active: true } } } },
          property: { select: { addressLine1: true, timezone: true } },
        },
      })
      if (showing) {
        return {
          ok: false,
          reason: verdict.reason,
          booked: {
            scheduledStart: showing.scheduledStart,
            unitName: showing.unit.name,
            addressLine1: showing.property.addressLine1,
            timezone: showing.property.timezone,
            selfService:
              showing.unit.status === 'VACANT' && showing.unit.smartLock?.active === true,
          },
        }
      }
    }
    return { ok: false, reason: verdict.reason }
  }

  const prospect = await prisma.prospect.findUnique({
    where: { id: stored!.subjectId },
    include: { property: true, listing: { include: { unit: true } } },
  })
  if (!prospect) return { ok: false, reason: 'not_found' }

  return {
    ok: true,
    prospectId: prospect.id,
    firstName: prospect.firstName,
    propertyId: prospect.propertyId,
    addressLine1: prospect.property.addressLine1,
    unitId: prospect.listing.unitId,
    unitName: prospect.listing.unit.name,
    unitStatus: prospect.listing.unit.status,
    timezone: prospect.property.timezone,
    state: prospect.property.state,
    county: prospect.property.county,
  }
}
