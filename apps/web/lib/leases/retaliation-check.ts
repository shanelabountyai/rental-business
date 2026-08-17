import 'server-only'

import { retaliationWarning, type RetaliationWarning } from '@rental/core/leases'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// The database half of the retaliation-claim guard (RISK-06, R-055; D-4).
// packages/core/leases/retaliation.ts decides; this fetches the two facts
// that decision needs and never any of its own.

/**
 * Is `actionDate` inside this lease's retaliation-presumption window?
 *
 * Looks up the property's own JurisdictionRule for `retaliationWindowDays`
 * and the tenancy's most recent habitability-flagged ticket - the same
 * signal R-023's auto-elevation already stamps at intake, so this item adds
 * no new complaint log, exactly as the backlog says.
 *
 * A missing JurisdictionRule (an unconfigured state) fails CLOSED for this
 * check specifically - `.catch(() => null)` - rather than throwing the way
 * `rulesFor` does for a fee or a grace period: those numbers are required to
 * compute a bill at all, but a guard with nothing to warn about is simply
 * silent, the same posture a null `retaliationWindowDays` already takes.
 */
export async function retaliationCheckFor(args: {
  leaseId: string
  propertyState: string
  propertyCounty: string | null
  actionDate: Date
}): Promise<RetaliationWarning | null> {
  const rule = await rulesFor(
    { state: args.propertyState, county: args.propertyCounty },
    args.actionDate,
  ).catch(() => null)
  if (!rule?.retaliationWindowDays) return null

  const ticket = await prisma.ticket.findFirst({
    where: { leaseId: args.leaseId, habitabilityFlag: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true, category: true, createdAt: true },
  })

  return retaliationWarning({
    actionDate: args.actionDate,
    mostRecentComplaint: ticket
      ? { ticketId: ticket.id, category: ticket.category, occurredAt: ticket.createdAt }
      : null,
    windowDays: rule.retaliationWindowDays,
  })
}
