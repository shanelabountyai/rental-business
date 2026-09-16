import 'server-only'

import type { AuditInput } from '@rental/core/audit'
import {
  retaliationWarning,
  validateRetaliationAck,
  type RetaliationComplaint,
  type RetaliationWarning,
} from '@rental/core/leases'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// The database half of the retaliation-claim guard (RISK-06, R-055; D-4).
// packages/core/leases/retaliation.ts decides; this fetches the two facts
// that decision needs and never any of its own.
//
// R-212 also put the WHOLE gate here - check, ack validation, refusal shape
// and audit row - because the guard had to reach five call sites and the two
// that already had it carried forty lines of it each. A sixth copy is how a
// guard ends up armed on four paths out of five, which is precisely the
// defect R-212 is fixing. This module is `server-only`, not `'use server'`,
// so it may export types and sync helpers that an action module may not.

/**
 * Is `actionDate` inside this lease's retaliation-presumption window?
 *
 * Looks up the property's own JurisdictionRule for `retaliationWindowDays`
 * and the tenancy's most recent PROTECTED ACT - a habitability-flagged
 * ticket (R-023 stamps the flag at intake) or a fair-housing accommodation
 * request (R-088). Whichever is later is the one that matters; if the newest
 * is outside the window, every earlier one necessarily is too.
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

  const [ticket, accommodation] = await Promise.all([
    prisma.ticket.findFirst({
      where: { leaseId: args.leaseId, habitabilityFlag: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, category: true, createdAt: true },
    }),
    // EVERY status, WITHDRAWN and DENIED included. The protected act is
    // ASKING - a request the owner turned down is the one most likely to be
    // what a retaliation claim says the rent rise was about.
    prisma.accommodationRequest.findFirst({
      where: { leaseId: args.leaseId },
      orderBy: { receivedOn: 'desc' },
      select: { id: true, receivedOn: true },
    }),
  ])

  const candidates: RetaliationComplaint[] = []
  if (ticket) {
    candidates.push({
      source: 'habitability_ticket',
      sourceId: ticket.id,
      description: `${ticket.category} complaint`,
      occurredAt: ticket.createdAt,
    })
  }
  if (accommodation) {
    candidates.push({
      source: 'accommodation_request',
      sourceId: accommodation.id,
      // `receivedOn` is `@db.Date` - UTC midnight of the day it arrived, read
      // as the instant it already is and NOT through a timezone (the @db.Date
      // rule in CLAUDE.md). The day count therefore runs from the START of
      // that day, which is how a statute counts one anyway.
      description: 'accommodation request',
      occurredAt: accommodation.receivedOn,
    })
  }
  const mostRecentComplaint =
    candidates.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] ?? null

  return retaliationWarning({
    actionDate: args.actionDate,
    mostRecentComplaint,
    windowDays: rule.retaliationWindowDays,
  })
}

/// The warning as a form state carries it: dates already in the property's
/// own timezone (D-3), because the banner is read by a human and never
/// recomputed from.
export interface RetaliationAckView {
  description: string
  /// ISO date only, in the property's own timezone (D-3).
  occurredOn: string
  daysAgo: number
  windowDays: number
}

export function retaliationAckView(
  warning: RetaliationWarning,
  timezone: string,
): RetaliationAckView {
  return {
    description: warning.description,
    occurredOn: businessDate(warning.occurredAt, timezone),
    daysAgo: warning.daysAgo,
    windowDays: warning.windowDays,
  }
}

/// What a caller must return, unchanged, when the gate refuses. Spread it
/// into that action's own form state alongside whatever `values` it echoes.
export interface RetaliationRefusal {
  error: string
  fieldErrors: Record<string, string>
  needsRetaliationAck: RetaliationAckView
}

/**
 * The guard as a caller uses it: check, then ack validation.
 *
 * `refusal` non-null means NOTHING MAY BE WRITTEN - return it. Saving the
 * adverse action and asking for the reason afterwards would leave an
 * unexplained, retaliatory-looking record if the second step never happened
 * (the same posture R-027's entry-notice override takes).
 *
 * `warning` non-null with no refusal means go ahead AND write the ack row -
 * write `retaliationAckAudit(...)` inside the same transaction as the write.
 */
export async function retaliationGateFor(args: {
  leaseId: string
  property: { state: string; county: string | null; timezone: string }
  actionDate: Date
  /// The noun in "This {action} is 24 days after this tenant's ...".
  action: string
  reason: string | null
}): Promise<{ warning: RetaliationWarning | null; refusal: RetaliationRefusal | null }> {
  const warning = await retaliationCheckFor({
    leaseId: args.leaseId,
    propertyState: args.property.state,
    propertyCounty: args.property.county,
    actionDate: args.actionDate,
  })
  if (!warning) return { warning: null, refusal: null }

  const violations = validateRetaliationAck(args.reason)
  if (violations.length === 0) return { warning, refusal: null }

  return {
    warning,
    refusal: {
      error: `This ${args.action} is ${warning.daysAgo} days after this tenant's ${warning.description}, inside the ${warning.windowDays}-day retaliation-presumption window for ${args.property.state}.`,
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
      needsRetaliationAck: retaliationAckView(warning, args.property.timezone),
    },
  }
}

/**
 * The row a retaliation defence stands or falls on - pass it to `audit()`
 * inside the same transaction as the write it justifies.
 *
 * Built here, written by the caller: importing `audit` would pull the
 * session and `next-auth` into a module the unit tests load directly.
 *
 * Always against the LEASE, whatever the adverse action was recorded as -
 * "what did this owner do to this tenancy, and why" is one question, and an
 * ack filed under an eviction case id would not answer it.
 */
export function retaliationAckAudit(args: {
  warning: RetaliationWarning
  reason: string
  leaseId: string
  propertyId: string
  /// What the owner went ahead and did, for the audit payload.
  trigger: string
  /// Anything else that makes the act legible two years later.
  details?: Record<string, unknown>
}): Omit<AuditInput, 'actor'> {
  return {
    action: 'lease.retaliation_window_acknowledged',
    entityType: 'Lease',
    entityId: args.leaseId,
    propertyId: args.propertyId,
    after: {
      trigger: args.trigger,
      ...args.details,
      complaintSource: args.warning.source,
      complaintSourceId: args.warning.sourceId,
      complaintOccurredAt: args.warning.occurredAt.toISOString(),
      daysAgo: args.warning.daysAgo,
      windowDays: args.warning.windowDays,
    },
    reasonCode: 'owner_directive',
    reason: args.reason,
  }
}
