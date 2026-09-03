// Which inspections owe the tenant an entry notice (R-157, INSP-01, D-4).
//
// `entryDecision` (packages/core/entry) had three callers - work orders,
// showings, abandonment - and no inspection path was one of them, so the
// auto-scheduled annual interior walk entered occupied homes with no notice
// at all: illegal-entry exposure that taints the very photos a deposit case
// rests on. This predicate is the seam that closes it: it names WHICH walks
// owe notice, and lib/inspections/scheduling.ts routes those through the
// same entryDecision → generate → serve → log chain work orders use.

import type { LeaseStatus } from '@rental/db'
import type { InspectionTypeValue } from './validate.ts'

/// The types whose walk goes INSIDE the dwelling. SEASONAL is the exterior
/// walk and DRIVE_BY never leaves the curb (INSP-04's own naming: "annual
/// interior, seasonal exterior, drive-bys") - entry-notice statutes govern
/// entering the home, not standing outside it. MOVE_IN is interior but
/// excluded below for a different reason.
const INTERIOR_TYPES: ReadonlySet<InspectionTypeValue> = new Set([
  'MOVE_IN',
  'MOVE_OUT',
  'PRE_MOVE_OUT',
  'PERIODIC',
])

/**
 * Whether performing this inspection requires an entry notice first.
 *
 * True only when BOTH hold: the walk enters the dwelling, and somebody is
 * living in it - a lease still ACTIVE or MONTH_TO_MONTH. A MOVE_OUT walked
 * after the lease is ENDED enters an empty unit; a PRE_MOVE_OUT is the
 * textbook case, the tenant is still home.
 *
 * MOVE_IN is exempt even on an ACTIVE lease: the walk happens at handover,
 * before the tenant is in residence, and the self-guided variant is the
 * tenant walking their own new home. If staff ever re-walk a MOVE_IN with
 * the tenant living there, the warn-and-override on finishing the walk is
 * the record of that judgement call - this predicate is not a hard block
 * anywhere it is read (R-027's posture).
 */
export function inspectionRequiresEntryNotice(
  type: InspectionTypeValue,
  leaseStatus: LeaseStatus | null,
): boolean {
  if (type === 'MOVE_IN') return false
  if (!INTERIOR_TYPES.has(type)) return false
  return leaseStatus === 'ACTIVE' || leaseStatus === 'MONTH_TO_MONTH'
}
