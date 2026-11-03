// Offboarding (PRD 10 §8, PRD 11 §4.6, D-319, D-325, R-300a): the org's
// lifecycle as pure decisions, so each refusal is tested with values and the
// actions only say it.
//
//   ACTIVE -> FROZEN -> ACTIVE (restore), or FROZEN -> OFFBOARDED (R-300b)
//
// FROZEN is read-only BY PERMISSIONS, the way a support session is (D-353):
// `frozenActor()` narrows every assignment to `FROZEN_PERMISSIONS`, so `can()`
// refuses every write without a branch of its own. OFFBOARDED leaves nothing.

import type { Actor } from './can.ts'
import { PERMISSIONS, type Permission } from './permissions.ts'

/// D-325 (Shane, answering OQ-26): the numbers counsel may change, here and
/// nowhere else.
export const FREEZE_WINDOW_DAYS = 90
export const EVIDENCE_RETENTION_YEARS = 7

export type OrgLifecycleStatus = 'PROVISIONING' | 'ACTIVE' | 'FROZEN' | 'OFFBOARDED'

/**
 * What a frozen org's people may still do: every read, plus the two that
 * produce a file from reads - the financial reports and the owner's portable
 * export (`property.export`, which also guards the org export, D-386). Both
 * archive what they hand over as a `Document`, which is a record of a read,
 * not a change to the org. Derived from the catalogue like
 * `SUPPORT_PERMISSIONS`, so a read added later survives a freeze and a write
 * never does.
 */
export const FROZEN_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => p.endsWith('.read') || p === 'report.financial' || p === 'property.export',
)

const KEEP: ReadonlySet<Permission> = new Set(FROZEN_PERMISSIONS)

/// The actor as its org's status allows. ACTIVE and PROVISIONING are untouched.
export function actorForOrgStatus(actor: Actor, status: OrgLifecycleStatus): Actor {
  if (status === 'ACTIVE' || status === 'PROVISIONING') return actor
  const assignments =
    status === 'FROZEN'
      ? actor.assignments.map((a) => ({ ...a, permissions: a.permissions.filter((p) => KEEP.has(p)) }))
      : []
  return { ...actor, assignments, readOnly: true }
}

/// The day the purge may run: the window counts from the freeze, not from the
/// press that scheduled it, so scheduling late never extends a frozen org's stay.
export function purgeDate(frozenAt: Date): Date {
  return new Date(frozenAt.getTime() + FREEZE_WINDOW_DAYS * 24 * 60 * 60_000)
}

export function freezeRefusal(status: OrgLifecycleStatus): string | null {
  if (status === 'ACTIVE') return null
  if (status === 'FROZEN') return 'The organisation is already frozen.'
  if (status === 'PROVISIONING') return 'An organisation still being set up cannot be frozen. It is not live yet.'
  return 'The organisation has been offboarded.'
}

export function restoreRefusal(status: OrgLifecycleStatus): string | null {
  if (status === 'FROZEN') return null
  return status === 'OFFBOARDED' ? 'The organisation has been offboarded and cannot be restored.' : 'The organisation is not frozen.'
}

export function scheduleOffboardRefusal(status: OrgLifecycleStatus, offboardAt: Date | null): string | null {
  if (status !== 'FROZEN') return 'Only a frozen organisation can be scheduled for offboarding.'
  return offboardAt ? 'Offboarding is already scheduled.' : null
}

/// The typed confirmation every lifecycle press asks for (PRD 11 §4.6).
export function slugConfirmRefusal(typed: string, slug: string): string | null {
  return typed.trim() === slug ? null : 'Type the slug exactly to confirm.'
}
