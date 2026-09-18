import 'server-only'

import { HOLD_DEFINITIONS, type HoldEffect, type HoldType, type PlacedHold, isHalted } from '@rental/core/holds'
import type { HeldSpan } from '@rental/core/ledger'
import { businessDate } from '@rental/core/scheduling'
import { type LeaseHoldType, prisma } from '@rental/db'

// Reading lease holds (R-084).
//
// ==========================================================================
// EVERY GUARD IN THE APP GOES THROUGH `leasesHalted`, AND THAT IS THE POINT.
//
// The failure this shape exists to prevent is the one CLAUDE.md already
// records for status enums: a seventh hold type gets added, and the fifth
// guard - written months earlier against `type === 'BANKRUPTCY'` - silently
// does not apply to it. Nothing here tests a type by name. A guard asks for
// an EFFECT, the effect table in packages/core/holds answers, and a new type
// that claims that effect is covered by every existing guard on the day it
// is added.
// ==========================================================================

/// Prisma's enum is SCREAMING_CASE; core's vocabulary is the lowercase one
/// the backlog and the UI use. Two small maps rather than one shared string,
/// because core must not import the Prisma client (the bundle crash R-010
/// and R-012 both hit) and the database must not hold lowercase enum labels.
const TO_CORE: Record<LeaseHoldType, HoldType> = {
  MILITARY_SCRA: 'military_scra',
  DECEASED: 'deceased',
  BANKRUPTCY: 'bankruptcy',
  DISPUTE: 'dispute',
  PAYMENT_PLAN: 'payment_plan',
  DO_NOT_CONTACT: 'do_not_contact',
  NOTICE_SERVED: 'notice_served',
}

const TO_DB: Record<HoldType, LeaseHoldType> = {
  military_scra: 'MILITARY_SCRA',
  deceased: 'DECEASED',
  bankruptcy: 'BANKRUPTCY',
  dispute: 'DISPUTE',
  payment_plan: 'PAYMENT_PLAN',
  do_not_contact: 'DO_NOT_CONTACT',
  notice_served: 'NOTICE_SERVED',
}

export function toCoreHoldType(type: LeaseHoldType): HoldType {
  return TO_CORE[type]
}

export function toDbHoldType(type: HoldType): LeaseHoldType {
  return TO_DB[type]
}

export interface HoldView {
  id: string
  type: HoldType
  reason: string
  placedAt: Date
  placedByName: string
  liftedAt: Date | null
  /// Who lifted it — a person's name, or the job that did (R-175). Never
  /// null on a lifted hold: the database's own check constraint requires
  /// exactly one of the two.
  liftedByName: string | null
  liftReason: string | null
}

const HOLD_SELECT = {
  id: true,
  type: true,
  reason: true,
  placedAt: true,
  liftedAt: true,
  liftedBySystem: true,
  liftReason: true,
  placedBy: { select: { name: true } },
  liftedBy: { select: { name: true } },
} as const

/// The jobs that lift holds, by the ref they write to `liftedBySystem`.
const SYSTEM_LIFTERS: Record<string, string> = {
  'job:payment_plan.check': 'the nightly payment-plan sweep',
  // R-227: a served notice cured, ran out, or its case closed.
  'job:ledger.late_fees': 'the nightly late-fee job',
}

function toView(row: {
  id: string
  type: LeaseHoldType
  reason: string
  placedAt: Date
  liftedAt: Date | null
  liftedBySystem: string | null
  liftReason: string | null
  placedBy: { name: string }
  liftedBy: { name: string } | null
}): HoldView {
  return {
    id: row.id,
    type: TO_CORE[row.type],
    reason: row.reason,
    placedAt: row.placedAt,
    placedByName: row.placedBy.name,
    liftedAt: row.liftedAt,
    // A job reads as what it is. R-175's sweep lifts a payment-plan hold
    // when an instalment goes unpaid, and "lifted by the nightly payment-plan
    // sweep" is the honest answer to who resumed collection.
    liftedByName:
      row.liftedBy?.name ??
      (row.liftedBySystem ? (SYSTEM_LIFTERS[row.liftedBySystem] ?? row.liftedBySystem) : null),
    liftReason: row.liftReason,
  }
}

/**
 * Every hold on one lease, live and lifted, newest first.
 *
 * Lifted rows come back deliberately: the panel shows them, because a hold
 * that was on for six weeks and came off is the fact somebody defending a
 * late fee assessed in week seven needs to see.
 */
export async function holdsForLease(leaseId: string): Promise<HoldView[]> {
  const rows = await prisma.leaseHold.findMany({
    where: { leaseId },
    select: HOLD_SELECT,
    orderBy: [{ liftedAt: { sort: 'asc', nulls: 'first' } }, { placedAt: 'desc' }],
  })
  return rows.map(toView)
}

/** Just the active ones, in the shape core's decisions take. */
export async function activeHoldsForLease(leaseId: string): Promise<PlacedHold[]> {
  const rows = await prisma.leaseHold.findMany({
    where: { leaseId, liftedAt: null },
    select: { type: true, liftedAt: true },
  })
  return rows.map((row) => ({ type: TO_CORE[row.type], liftedAt: row.liftedAt }))
}

async function haltedBy(
  where: { leaseId: { in: string[] } } | { propertyId: string },
  effect: HoldEffect,
): Promise<ReadonlySet<string>> {
  const rows = await prisma.leaseHold.findMany({
    where: { ...where, liftedAt: null },
    select: { leaseId: true, type: true, liftedAt: true },
  })

  const byLease = new Map<string, PlacedHold[]>()
  for (const row of rows) {
    const list = byLease.get(row.leaseId) ?? []
    list.push({ type: TO_CORE[row.type], liftedAt: row.liftedAt })
    byLease.set(row.leaseId, list)
  }

  const halted = new Set<string>()
  for (const [leaseId, holds] of byLease) {
    if (isHalted(holds, effect)) halted.add(leaseId)
  }
  return halted
}

/**
 * THE CHOKE POINT. Which of these leases are halted for this effect.
 *
 * Takes a set of lease ids rather than one, because every caller is a sweep
 * or a bulk action: a per-lease call inside a loop over a property's whole
 * rent roll is a query per tenancy, on the nightly job, for ever.
 *
 * An empty input returns an empty set without touching the database - the
 * ordinary case for a small portfolio where nobody has ever placed a hold.
 */
export async function leasesHalted(
  leaseIds: readonly string[],
  effect: HoldEffect,
): Promise<ReadonlySet<string>> {
  if (leaseIds.length === 0) return new Set()
  return haltedBy({ leaseId: { in: [...leaseIds] } }, effect)
}

/**
 * The same question for a whole property, without having to name the leases
 * first — what the nightly per-property sweeps want.
 */
export function haltedLeasesInProperty(
  propertyId: string,
  effect: HoldEffect,
): Promise<ReadonlySet<string>> {
  return haltedBy({ propertyId }, effect)
}

/**
 * Every span a hold with this effect was in force, live AND lifted, by lease,
 * in property-local days (R-227). What the late-fee job needs to leave the
 * held days out of a fee once the hold is off - `haltedLeasesInProperty`
 * answers only "is it held now", and a lifted hold's days still must never
 * be charged.
 */
export async function heldSpansInProperty(
  propertyId: string,
  effect: HoldEffect,
  timeZone: string,
): Promise<ReadonlyMap<string, HeldSpan[]>> {
  const rows = await prisma.leaseHold.findMany({
    where: { propertyId },
    select: { leaseId: true, type: true, placedAt: true, liftedAt: true },
  })
  const spans = new Map<string, HeldSpan[]>()
  for (const row of rows) {
    if (!HOLD_DEFINITIONS[TO_CORE[row.type]].effects.includes(effect)) continue
    const list = spans.get(row.leaseId) ?? []
    list.push({
      from: businessDate(row.placedAt, timeZone),
      until: row.liftedAt ? businessDate(row.liftedAt, timeZone) : null,
    })
    spans.set(row.leaseId, list)
  }
  return spans
}
