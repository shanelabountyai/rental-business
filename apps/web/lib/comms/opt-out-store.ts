import 'server-only'

import { normalizePhone } from '@rental/core/comms'
import { prisma } from '@rental/db'
// From system.ts, not index.ts: index pulls in Auth.js, and neither a webhook
// nor the send path has a session. The same reason sms-intake.ts imports it
// this way, and the same mistake caught the same way - by the test suite
// refusing to load `next/server`.
import { auditAsSystem } from '@/lib/audit/system.ts'

// Reading and writing the carrier opt-out state (R-040e, D-38).
//
// Everything here normalises the number first. A STOP arrives from the
// carrier as E.164, but the numbers we hold were typed by staff in whatever
// shape the person on the phone read them out - and an opt-out recorded
// against `(512) 555-0134` that is then looked up as `+15125550134` is an
// opt-out that does nothing, which is the failure mode this whole item
// exists to prevent.

/**
 * Is this number blocked right now?
 *
 * Returns false for a number we cannot normalise rather than throwing: an
 * unparseable number cannot have opted out, and a send path is the wrong
 * place to discover that a phone column is malformed.
 */
export async function isOptedOut(phone: string | null | undefined): Promise<boolean> {
  const normalized = phone ? normalizePhone(phone) : null
  if (!normalized) return false

  const row = await prisma.smsOptOut.findFirst({
    where: { phone: normalized, revokedAt: null },
    select: { id: true },
  })
  return row !== null
}

/**
 * All of these numbers that are currently blocked.
 *
 * One query for a fan-out, rather than one per recipient - the escalation
 * sweep pages several people at once and R-102b is a fresh reminder of what
 * per-row queries cost against a remote database.
 */
export async function blockedNumbers(
  phones: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const normalized = phones
    .map((phone) => (phone ? normalizePhone(phone) : null))
    .filter((phone): phone is string => phone !== null)
  if (normalized.length === 0) return new Set()

  const rows = await prisma.smsOptOut.findMany({
    where: { phone: { in: normalized }, revokedAt: null },
    select: { phone: true },
  })
  return new Set(rows.map((row) => row.phone))
}

/**
 * Record that a number is blocked.
 *
 * Idempotent, because both sources can report the same opt-out: the tenant
 * texts STOP and the carrier also fails the next send with 21610. Re-opting
 * out an already-blocked number must not move `optedOutAt` — the date it
 * started is the fact worth keeping, and overwriting it would quietly
 * shorten the window somebody is later trying to account for.
 */
export async function recordOptOut(args: {
  phone: string
  source: 'INBOUND_KEYWORD' | 'CARRIER_CALLBACK'
  reason: string
}): Promise<{ recorded: boolean; phone: string | null }> {
  const phone = normalizePhone(args.phone)
  if (!phone) return { recorded: false, phone: null }

  const existing = await prisma.smsOptOut.findUnique({ where: { phone } })
  if (existing && existing.revokedAt === null) {
    return { recorded: false, phone }
  }

  await prisma.smsOptOut.upsert({
    where: { phone },
    create: { phone, source: args.source, reason: args.reason },
    // A number that opted out, back in, and out again: same row, new dates,
    // and `revokedAt` cleared so the partial index sees it as active.
    update: {
      source: args.source,
      reason: args.reason,
      optedOutAt: new Date(),
      revokedAt: null,
    },
  })

  // SYSTEM, because nobody on our side did this - the recipient did, or the
  // carrier did on their behalf. Attributing it to a staff actor would put a
  // name against a decision they did not make.
  await auditAsSystem('sms-opt-out', {
    action: 'notification.opted_out',
    entityType: 'SmsOptOut',
    entityId: phone,
    after: { phone, source: args.source, reason: args.reason },
  }).catch((error) => {
    // The opt-out is already recorded and is the part that must not be lost.
    console.error('[sms] failed to audit an opt-out', error)
  })

  return { recorded: true, phone }
}

/** Record that a number has opted back in. */
export async function recordOptIn(args: {
  phone: string
  reason: string
}): Promise<{ recorded: boolean; phone: string | null }> {
  const phone = normalizePhone(args.phone)
  if (!phone) return { recorded: false, phone: null }

  const updated = await prisma.smsOptOut.updateMany({
    where: { phone, revokedAt: null },
    data: { revokedAt: new Date(), reason: args.reason },
  })
  if (updated.count === 0) return { recorded: false, phone }

  await auditAsSystem('sms-opt-out', {
    action: 'notification.opted_in',
    entityType: 'SmsOptOut',
    entityId: phone,
    after: { phone, reason: args.reason },
  }).catch((error) => {
    console.error('[sms] failed to audit an opt-in', error)
  })

  return { recorded: true, phone }
}
