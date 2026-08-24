import 'server-only'

import { prisma } from '@rental/db'

// Reads for the smart lock on a unit (LEASE-08, PROP-03; R-094). Called only
// after the caller has checked `unit.read` against the unit's own property -
// the same convention lib/operational/queries.ts follows.

export async function smartLockPanel(unitId: string) {
  const lock = await prisma.smartLock.findUnique({ where: { unitId } })
  if (!lock) return null

  const [accesses, events] = await Promise.all([
    // Live and recent codes, newest window first. A revoked row stays in the
    // list, because "was that code live at 3pm on Tuesday" is the question,
    // and a list that hid killed codes could not answer it.
    prisma.showingAccess.findMany({
      where: { smartLockId: lock.id },
      orderBy: { validFrom: 'desc' },
      take: 10,
      include: {
        showing: {
          select: {
            id: true,
            status: true,
            scheduledStart: true,
            prospect: { select: { firstName: true, lastName: true } },
          },
        },
        identityCheck: { select: { result: true, documentName: true, checkedAt: true } },
        revokedBy: { select: { name: true } },
      },
    }),
    prisma.lockEvent.findMany({
      where: { smartLockId: lock.id },
      orderBy: { occurredAt: 'desc' },
      take: 25,
      include: {
        access: {
          select: { showing: { select: { prospect: { select: { firstName: true, lastName: true } } } } },
        },
      },
    }),
  ])

  return { lock, accesses, events }
}
