import {
  MissingAuditReasonError,
  auditTrailFor,
  recordAudit,
} from '@rental/core/audit'
import { prisma } from '@rental/db'
import { afterAll, describe, expect, it } from 'vitest'

// The audit service against a real database. What needs proving here rather
// than in packages/core:
//
//   Atomicity. An entry and the change it describes must land together or not
//   at all. Nothing else in the product can verify that - it needs a real
//   transaction that really rolls back.
//
//   Immutability. R-002's trigger has to still be protecting this table now
//   that something actually writes to it.
//
//   That redaction survives the round-trip through a jsonb column.
//
// AuditLog is append-only by trigger, so these rows CANNOT be cleaned up. Every
// test therefore runs inside a transaction that never commits, exactly as
// packages/db/schema.test.ts does.

class Rollback extends Error {}

afterAll(async () => {
  await prisma.$disconnect()
})

const SYSTEM = { type: 'SYSTEM', ref: 'audit-test' } as const

/** Runs `body` in a transaction that always rolls back. */
async function inRollback(
  body: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>,
) {
  await expect(
    prisma.$transaction(
      async (tx) => {
        await body(tx)
        throw new Rollback()
      },
      { timeout: 30_000 },
    ),
  ).rejects.toThrow(Rollback)
}

describe('recording an entry', () => {
  it('writes actor, action, entity and payload', async () => {
    await inRollback(async (tx) => {
      await recordAudit(tx, {
        actor: { type: 'STAFF', staffUserId: null, ipAddress: '203.0.113.7' },
        action: 'workorder.approved',
        entityType: 'WorkOrder',
        entityId: 'wo_1',
        before: { status: 'PENDING_APPROVAL' },
        after: { status: 'APPROVED' },
      })

      const entry = await tx.auditLog.findFirstOrThrow({
        where: { entityId: 'wo_1' },
      })
      expect(entry.action).toBe('workorder.approved')
      expect(entry.actorType).toBe('STAFF')
      expect(entry.ipAddress).toBe('203.0.113.7')
      expect(entry.before).toEqual({ status: 'PENDING_APPROVAL' })
      expect(entry.after).toEqual({ status: 'APPROVED' })
    })
  })

  // The failure this service exists to prevent: a row snapshot copying a
  // password hash into an append-only table that cannot be cleaned up.
  it('never lets a secret reach the column', async () => {
    await inRollback(async (tx) => {
      await recordAudit(tx, {
        actor: SYSTEM,
        action: 'auth.password_reset',
        entityType: 'StaffUser',
        entityId: 'staff_1',
        before: { passwordHash: 'scrypt$OLD-SECRET', email: 'a@b.test' },
        after: { passwordHash: 'scrypt$NEW-SECRET', email: 'a@b.test' },
      })

      const entry = await tx.auditLog.findFirstOrThrow({
        where: { entityId: 'staff_1' },
      })
      const serialised = JSON.stringify(entry)
      expect(serialised).not.toContain('OLD-SECRET')
      expect(serialised).not.toContain('NEW-SECRET')
      expect(entry.after).toEqual({ passwordHash: '[redacted]' })
    })
  })

  it('stores only what changed', async () => {
    await inRollback(async (tx) => {
      await recordAudit(tx, {
        actor: SYSTEM,
        action: 'ledger.adjusted',
        entityType: 'Lease',
        entityId: 'lease_1',
        before: { rentCents: 185_000, status: 'ACTIVE', unitId: 'unit_1' },
        after: { rentCents: 195_000, status: 'ACTIVE', unitId: 'unit_1' },
        reasonCode: 'correction',
        reason: 'Renewal rate applied a month late',
      })

      const entry = await tx.auditLog.findFirstOrThrow({
        where: { entityId: 'lease_1' },
      })
      expect(entry.before).toEqual({ rentCents: 185_000 })
      expect(entry.after).toEqual({ rentCents: 195_000 })
      expect(entry.reasonCode).toBe('correction')
    })
  })

  it('refuses a reason-requiring action with no reason', async () => {
    await expect(
      recordAudit(prisma, {
        actor: SYSTEM,
        action: 'fee.waived',
        entityType: 'Charge',
        entityId: 'charge_1',
      }),
    ).rejects.toThrow(MissingAuditReasonError)

    // ...and wrote nothing. A waiver with no stated reason is exactly the
    // pattern PAY-04's fair-housing report needs to be able to see.
    expect(
      await prisma.auditLog.count({ where: { entityId: 'charge_1' } }),
    ).toBe(0)
  })

  it('accepts a reason code alone, without free text', async () => {
    await inRollback(async (tx) => {
      await recordAudit(tx, {
        actor: SYSTEM,
        action: 'fee.waived',
        entityType: 'Charge',
        entityId: 'charge_2',
        reasonCode: 'first_occurrence',
      })
      expect(await tx.auditLog.count({ where: { entityId: 'charge_2' } })).toBe(1)
    })
  })
})

describe('atomicity', () => {
  // The whole reason recordAudit takes a transaction client. If the entry were
  // written outside the transaction, this test would find an audit row
  // describing a change that never happened - a log that lies, which is worse
  // than no log at all.
  it('leaves no entry behind when the action rolls back', async () => {
    const marker = `atomicity-${Date.now()}`

    await expect(
      prisma.$transaction(async (tx) => {
        const entity = await tx.legalEntity.create({
          data: { name: marker, type: 'LLC' },
        })
        await recordAudit(tx, {
          actor: SYSTEM,
          action: 'staff.assignment_granted',
          entityType: 'LegalEntity',
          entityId: entity.id,
          after: { name: marker },
        })
        throw new Rollback()
      }),
    ).rejects.toThrow(Rollback)

    expect(await prisma.legalEntity.count({ where: { name: marker } })).toBe(0)
    expect(
      await prisma.auditLog.count({ where: { entityType: 'LegalEntity', action: 'staff.assignment_granted' } }),
    ).toBeGreaterThanOrEqual(0)
    // Precisely: no entry naming this marker survived.
    const orphans = await prisma.auditLog.findMany({
      where: { entityType: 'LegalEntity' },
      select: { after: true },
    })
    expect(
      orphans.filter((row) => JSON.stringify(row.after).includes(marker)),
    ).toEqual([])
  })
})

describe('immutability (ROLE-03)', () => {
  it('cannot be edited by anyone, including the service that wrote it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await recordAudit(tx, {
          actor: SYSTEM,
          action: 'accesscode.revealed',
          entityType: 'WorkOrder',
          entityId: 'wo_immutable',
        })
        const entry = await tx.auditLog.findFirstOrThrow({
          where: { entityId: 'wo_immutable' },
        })
        await tx.auditLog.update({
          where: { id: entry.id },
          data: { action: 'auth.signed_in' },
        })
      }),
    ).rejects.toThrow(/append-only/)
  })

  it('cannot be deleted', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await recordAudit(tx, {
          actor: SYSTEM,
          action: 'accesscode.revealed',
          entityType: 'WorkOrder',
          entityId: 'wo_undeletable',
        })
        const entry = await tx.auditLog.findFirstOrThrow({
          where: { entityId: 'wo_undeletable' },
        })
        await tx.auditLog.delete({ where: { id: entry.id } })
      }),
    ).rejects.toThrow(/append-only/)
  })
})

describe('reading the trail', () => {
  it('returns one record’s history oldest-first', async () => {
    await inRollback(async (tx) => {
      for (const action of [
        'workorder.approved',
        'accesscode.revealed',
        'workorder.chargeback_posted',
      ] as const) {
        await recordAudit(tx, {
          actor: SYSTEM,
          action,
          entityType: 'WorkOrder',
          entityId: 'wo_trail',
        })
      }

      const trail = await auditTrailFor(tx, 'WorkOrder', 'wo_trail')
      expect(trail.map((entry) => entry.action)).toEqual([
        'workorder.approved',
        'accesscode.revealed',
        'workorder.chargeback_posted',
      ])
      // Read as a story in a dispute, not scanned as a feed.
      const times = trail.map((entry) => entry.occurredAt.getTime())
      expect([...times].sort((a, b) => a - b)).toEqual(times)
    })
  })

  it('does not mix in another record’s history', async () => {
    await inRollback(async (tx) => {
      await recordAudit(tx, {
        actor: SYSTEM,
        action: 'workorder.approved',
        entityType: 'WorkOrder',
        entityId: 'wo_mine',
      })
      await recordAudit(tx, {
        actor: SYSTEM,
        action: 'workorder.approved',
        entityType: 'WorkOrder',
        entityId: 'wo_theirs',
      })
      expect(await auditTrailFor(tx, 'WorkOrder', 'wo_mine')).toHaveLength(1)
    })
  })
})
