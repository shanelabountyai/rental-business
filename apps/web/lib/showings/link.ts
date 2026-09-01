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
      /// WHAT THEY ARE ACTUALLY COMING TO SEE (R-141). This page used to
      /// carry a first name and a street address and nothing else - no rent,
      /// no size, no availability - so somebody deciding whether to spend an
      /// hour of a Saturday on it had to go back to whichever listing they
      /// came from, if they still had it. Every field here is already on the
      /// Listing the prospect is attached to; none of it is new state.
      headline: string | null
      rentCents: number
      /// `@db.Date`, so it is a calendar day and no timezone may touch it
      /// (D-3) - the page reads it with `utcToBusinessDate`.
      availableOn: Date
      bedrooms: number | null
      /// Prisma `Decimal`, stringified here rather than in the page: a
      /// Decimal cannot cross the Server->Client boundary, and this result
      /// is one `await` away from a client component.
      bathrooms: string | null
      squareFeet: number | null
      /// Whether they let themselves in or somebody meets them, said BEFORE
      /// they book rather than only on the confirmation - it is the
      /// difference between needing us there and not. Same derivation the
      /// `booked` branch below already uses, deliberately not a second one.
      selfService: boolean
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
    include: {
      property: true,
      listing: { include: { unit: { include: { smartLock: { select: { active: true } } } } } },
    },
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
    headline: prospect.listing.headline,
    rentCents: prospect.listing.rentCents,
    availableOn: prospect.listing.availableOn,
    bedrooms: prospect.listing.unit.bedrooms,
    bathrooms: prospect.listing.unit.bathrooms?.toString() ?? null,
    squareFeet: prospect.listing.unit.squareFeet,
    selfService:
      prospect.listing.unit.status === 'VACANT' &&
      prospect.listing.unit.smartLock?.active === true,
  }
}
