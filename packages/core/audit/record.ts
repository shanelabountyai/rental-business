import type { Prisma, PrismaClient } from '@rental/db'
import {
  type AuditAction,
  type ReasonCode,
  requiresReason,
} from './events.ts'
import { type Snapshot, changedFields } from './redact.ts'

// The write path. One function, so there is one place that decides what an
// audit entry looks like and one place to audit for mistakes.
//
// THE TRANSACTION RULE. `db` is a Prisma client OR a transaction client, and
// callers should pass the transaction the action itself runs in:
//
//   await prisma.$transaction(async (tx) => {
//     await tx.staffAssignment.update(...)
//     await recordAudit(tx, {...})
//   })
//
// That makes the entry and the change atomic. Either both land or neither
// does, so the log can never claim something that did not happen, and a change
// can never happen unrecorded. Logging after the fact, outside the
// transaction, produces exactly the two failure modes an evidence trail cannot
// have - and the second one is silent.
//
// The append-only trigger from R-002 does the rest: once written, an entry
// cannot be edited or deleted by any role (ROLE-03).

/// Anything that can run a Prisma write - the client, or a transaction client
/// inside `$transaction`.
export type AuditDb = PrismaClient | Prisma.TransactionClient

export interface AuditActor {
  type: 'STAFF' | 'TENANT' | 'GUARANTOR' | 'VENDOR' | 'SYSTEM'
  /// Set only for STAFF; the foreign key that ties the entry to a person.
  staffUserId?: string | null
  /// Non-staff identity: a tenant id, a guarantor id, a vendor id, or a job
  /// name. Free text because a nightly job is a legitimate actor and is not
  /// a row anywhere.
  ref?: string | null
  ipAddress?: string | null
  userAgent?: string | null
}

export interface AuditInput {
  actor: AuditActor
  action: AuditAction
  entityType: string
  entityId: string
  /// Scopes the entry for R-004's property filtering, so a property-scoped
  /// manager reading the audit trail sees their properties and no others.
  propertyId?: string | null
  before?: Snapshot
  after?: Snapshot
  reasonCode?: ReasonCode | null
  reason?: string | null
}

export class MissingAuditReasonError extends Error {
  // Not a constructor parameter property: Node's strip-only TypeScript support
  // cannot emit the implied assignment, and the CLI scripts import this module
  // under exactly that. It fails at import time, not at call time.
  readonly action: AuditAction

  constructor(action: AuditAction) {
    super(
      `${action} cannot be recorded without a reason. It is on REASON_REQUIRED because "why" is the point of the record.`,
    )
    this.name = 'MissingAuditReasonError'
    this.action = action
  }
}

/**
 * Writes one audit entry. Throws if a reason-requiring action arrives without
 * one - failing the action is correct, because an entry that cannot answer
 * "why" is not worth the row it occupies and the caller has a bug.
 *
 * Redaction is unconditional and happens here, not at the call site. See
 * redact.ts for why that is not negotiable.
 */
export async function recordAudit(
  db: AuditDb,
  input: AuditInput,
): Promise<void> {
  const reason = input.reason?.trim()
  if (requiresReason(input.action) && !reason && !input.reasonCode) {
    throw new MissingAuditReasonError(input.action)
  }

  const change = changedFields(input.before, input.after)

  await db.auditLog.create({
    data: {
      actorType: input.actor.type,
      actorStaffId: input.actor.staffUserId ?? null,
      actorRef: input.actor.ref ?? null,
      ipAddress: input.actor.ipAddress ?? null,
      userAgent: input.actor.userAgent ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      propertyId: input.propertyId ?? null,
      before: (change.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (change.after ?? undefined) as Prisma.InputJsonValue | undefined,
      reasonCode: input.reasonCode ?? null,
      reason: reason || null,
    },
  })
}

/**
 * The trail for one record, oldest first - "here is the contemporaneous
 * record", which ROLE-03 calls the defense in every dispute.
 *
 * Chronological rather than newest-first because this is read as a story in a
 * dispute, not scanned as a feed.
 */
export async function auditTrailFor(
  db: AuditDb,
  entityType: string,
  entityId: string,
) {
  return db.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { occurredAt: 'asc' },
    include: {
      actorStaff: { select: { id: true, name: true, email: true } },
    },
  })
}
