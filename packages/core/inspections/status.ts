// The inspection lifecycle (INSP-01, R-068).
//
// NO STATUS COLUMN. `Inspection` already carries `scheduledFor`,
// `performedAt`, `tenantSignedAt` and `lockedAt` as facts, each written by
// the action that makes it true - the same call `Lease.noticeGivenAt`
// already makes over a dedicated status column (LeaseStatus's own schema
// comment: a status that could drift from the facts is worse than deriving
// it). This module is the one place that reads the facts in order and
// names what they mean.
//
// Phase 1 of this item (R-068) stops short of e-sign and auto-finalize -
// `tenantSignedAt` and `lockedAt` are both written by a staff action here,
// never by a tenant-facing flow yet. SIGNED is still a real, reachable
// status: a staff member can record that a tenant signed in person on the
// inspector's own phone (INSP-01's own "or on the inspector's phone")
// without the report being locked in the same instant.

export type InspectionStatusValue =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'PENDING_SIGNATURE'
  | 'SIGNED'
  | 'LOCKED'

export interface InspectionStatusFacts {
  scheduledFor: Date | null
  performedAt: Date | null
  tenantSignedAt: Date | null
  lockedAt: Date | null
  /// Whether any item has a condition recorded yet - the difference between
  /// "created" and "somebody has actually started walking it".
  anyItemRecorded: boolean
}

export function inspectionStatus(facts: InspectionStatusFacts): InspectionStatusValue {
  if (facts.lockedAt) return 'LOCKED'
  if (facts.tenantSignedAt) return 'SIGNED'
  if (facts.performedAt) return 'PENDING_SIGNATURE'
  if (facts.anyItemRecorded) return 'IN_PROGRESS'
  if (facts.scheduledFor) return 'SCHEDULED'
  return 'DRAFT'
}

export const INSPECTION_STATUS_LABELS: Record<InspectionStatusValue, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  PENDING_SIGNATURE: 'Pending signature',
  SIGNED: 'Signed',
  LOCKED: 'Locked',
}

interface TransitionDecision {
  allowed: boolean
  message?: string
}

/**
 * Whether an item's condition/notes may still be written.
 *
 * Anywhere before LOCKED, deliberately - marking the walk "performed" is
 * not itself a lock, so a staff member catching a mistake before the
 * tenant signs can still fix it. Once `lockedAt` is set the report is
 * evidence (the model's own comment): nothing about it may change again.
 */
export function canEditItem(facts: { lockedAt: Date | null }): TransitionDecision {
  if (facts.lockedAt) {
    return { allowed: false, message: 'This report is locked and cannot be edited.' }
  }
  return { allowed: true }
}

/**
 * Whether the walk can be marked performed - every checklist item needs a
 * recorded condition first. "The whole point of a checklist" (INSP-01):
 * a report with blank rows is not evidence of anything having been
 * checked.
 */
export function canFinishInspection(facts: {
  lockedAt: Date | null
  performedAt: Date | null
  items: readonly { condition: string | null }[]
}): TransitionDecision {
  if (facts.lockedAt) return { allowed: false, message: 'This report is locked.' }
  if (facts.performedAt) return { allowed: false, message: 'Already marked performed.' }
  if (facts.items.length === 0) {
    return { allowed: false, message: 'Add at least one item before finishing.' }
  }
  const unrecorded = facts.items.filter((item) => item.condition == null).length
  if (unrecorded > 0) {
    return {
      allowed: false,
      message: `${unrecorded} item${unrecorded === 1 ? '' : 's'} still need${unrecorded === 1 ? 's' : ''} a condition.`,
    }
  }
  return { allowed: true }
}

/**
 * Whether a signature may be recorded - once performed, and only once.
 * Phase 1 posture: staff records that a tenant signed in person on the
 * inspector's own phone (INSP-01's own wording) - there is no tenant-portal
 * e-sign flow yet, so this is the only path to SIGNED.
 */
export function canRecordSignature(facts: {
  performedAt: Date | null
  tenantSignedAt: Date | null
  lockedAt: Date | null
}): TransitionDecision {
  if (facts.lockedAt) return { allowed: false, message: 'This report is locked.' }
  if (facts.tenantSignedAt) return { allowed: false, message: 'Already signed.' }
  if (!facts.performedAt) {
    return { allowed: false, message: 'Finish the walk before recording a signature.' }
  }
  return { allowed: true }
}

/**
 * Whether the report may be locked - only once performed. Signature is
 * optional in phase 1 (a staff member may lock a performed-but-unsigned
 * report, e.g. a periodic inspection nobody needs to countersign); R-069/
 * R-070's own move-in/move-out flows are where signature actually gates
 * anything.
 */
export function canLockInspection(facts: {
  performedAt: Date | null
  lockedAt: Date | null
}): TransitionDecision {
  if (facts.lockedAt) return { allowed: false, message: 'Already locked.' }
  if (!facts.performedAt) {
    return { allowed: false, message: 'Finish the walk before locking the report.' }
  }
  return { allowed: true }
}
