import 'server-only'

import { checkToken, hashToken } from '@rental/core/auth'
import { prisma } from '@rental/db'

// Reading a SHOWING_ACCESS link (LEASE-08, R-094).
//
// NON-CONSUMING, like `showingLinkStatus` - but for a different reason worth
// stating, because the two links are not the same kind of thing. The booking
// link is single-use and burned on the slot it books. This one is MULTI-USE
// until it expires (D-16's posture, the vendor links' shape): it is opened
// once in advance to get the identity check done and again standing at the
// door, and a link that died on first open would leave somebody outside a
// house.
//
// It never consumes and it never decides. `selfShowingDecision` in
// packages/core/scheduling is what decides, on every read, from the state at
// that moment - so a code can be killed after this message was sent and read.

export type ShowingAccessLink =
  | {
      ok: true
      showingId: string
      showingStatus: string
      prospectId: string
      prospectName: string
      firstName: string
      propertyId: string
      addressLine1: string
      unitId: string
      unitName: string
      unitStatus: string
      timezone: string
      scheduledStart: Date
      scheduledEnd: Date
      smartLock: { id: string; externalId: string; active: boolean } | null
      /// The check that bought the code, where one has been issued;
      /// otherwise the most recent attempt, so the page can say what
      /// happened last time rather than starting blank.
      identity: {
        id: string
        result: string
        documentName: string
        checkedAt: Date
      } | null
      access: {
        id: string
        sealedCode: string
        providerRef: string
        validFrom: Date
        validTo: Date
        revokedAt: Date | null
      } | null
    }
  | { ok: false; reason: string }

export async function showingAccessLinkStatus(rawToken: string): Promise<ShowingAccessLink> {
  const stored = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(rawToken) } })
  const verdict = checkToken(stored, { purpose: 'SHOWING_ACCESS', subjectType: 'Showing' })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const showing = await prisma.showing.findUnique({
    where: { id: stored!.subjectId },
    include: {
      property: { select: { id: true, addressLine1: true, timezone: true } },
      unit: { select: { id: true, name: true, status: true, smartLock: true } },
      prospect: { select: { id: true, firstName: true, lastName: true } },
      access: { include: { identityCheck: true } },
    },
  })
  if (!showing) return { ok: false, reason: 'not_found' }

  // The check pinned to the issued code where there is one; otherwise the
  // last attempt. Never "the best attempt" - a prospect who failed, then
  // passed under a different name, must not have the failure hidden.
  const latest =
    showing.access?.identityCheck ??
    (await prisma.identityCheck.findFirst({
      where: { prospectId: showing.prospectId },
      orderBy: { checkedAt: 'desc' },
    }))

  return {
    ok: true,
    showingId: showing.id,
    showingStatus: showing.status,
    prospectId: showing.prospectId,
    prospectName: `${showing.prospect.firstName} ${showing.prospect.lastName}`,
    firstName: showing.prospect.firstName,
    propertyId: showing.property.id,
    addressLine1: showing.property.addressLine1,
    unitId: showing.unit.id,
    unitName: showing.unit.name,
    unitStatus: showing.unit.status,
    timezone: showing.property.timezone,
    scheduledStart: showing.scheduledStart,
    scheduledEnd: showing.scheduledEnd,
    smartLock: showing.unit.smartLock
      ? {
          id: showing.unit.smartLock.id,
          externalId: showing.unit.smartLock.externalId,
          active: showing.unit.smartLock.active,
        }
      : null,
    identity: latest
      ? {
          id: latest.id,
          result: latest.result,
          documentName: latest.documentName,
          checkedAt: latest.checkedAt,
        }
      : null,
    access: showing.access
      ? {
          id: showing.access.id,
          sealedCode: showing.access.sealedCode,
          providerRef: showing.access.providerRef,
          validFrom: showing.access.validFrom,
          validTo: showing.access.validTo,
          revokedAt: showing.access.revokedAt,
        }
      : null,
  }
}
