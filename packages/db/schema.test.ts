import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from './index.ts'

// The two things in R-002 that are logic rather than declaration, and so are
// the two things worth a runnable check:
//
//   1. The append-only triggers actually reject. A schema comment saying
//      "append-only" proves nothing; a rejected UPDATE proves it.
//   2. The two-payer shape round-trips - one Charge split across two
//      LeasePayers, summing back to the charge amount, with the lease still
//      showing one balance.
//
// Every test runs inside a transaction that never commits, so this suite
// leaves nothing behind. That matters more than usual here: the tables under
// test cannot be cleaned up afterwards by design, so a test that committed
// would permanently litter the database it ran against.

afterAll(async () => {
  await prisma.$disconnect()
})

/** Sentinel used to roll back a transaction that did not fail on its own. */
class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Minimum viable entity chain: entity -> property -> unit -> lease. */
async function seedLease(tx: Tx) {
  const legalEntity = await tx.legalEntity.create({
    data: { name: 'Test Holdings LLC', type: 'LLC' },
  })
  const property = await tx.property.create({
    data: {
      legalEntityId: legalEntity.id,
      name: '123 Test St',
      addressLine1: '123 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  const unit = await tx.unit.create({
    data: { propertyId: property.id, name: 'Main house' },
  })
  const lease = await tx.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      startsOn: new Date('2026-01-01'),
      rentCents: 185_000,
    },
  })
  return { legalEntity, property, unit, lease }
}

describe('append-only tables', () => {
  // The trigger aborts the transaction itself, so there is nothing to clean
  // up on the failure path - the rejection IS the rollback.
  it('rejects UPDATE on LedgerEntry', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property, lease } = await seedLease(tx)
          const entry = await tx.ledgerEntry.create({
            data: {
              propertyId: property.id,
              leaseId: lease.id,
              type: 'CHARGE',
              amountCents: 185_000,
              description: 'January rent',
              occurredAt: new Date('2026-01-01T06:00:00Z'),
            },
          })
          await tx.ledgerEntry.update({
            where: { id: entry.id },
            data: { amountCents: 1 },
          })
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects DELETE on LedgerEntry', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property, lease } = await seedLease(tx)
          const entry = await tx.ledgerEntry.create({
            data: {
              propertyId: property.id,
              leaseId: lease.id,
              type: 'PAYMENT',
              amountCents: -185_000,
              description: 'January rent paid',
              occurredAt: new Date('2026-01-02T06:00:00Z'),
            },
          })
          await tx.ledgerEntry.delete({ where: { id: entry.id } })
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects UPDATE on AuditLog', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const log = await tx.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            entityType: 'Lease',
            entityId: 'test',
            action: 'test.performed',
          },
        })
        await tx.auditLog.update({
          where: { id: log.id },
          data: { action: 'test.rewritten' },
        })
      }),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects DELETE on AuditLog', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const log = await tx.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            entityType: 'Lease',
            entityId: 'test',
            action: 'test.performed',
          },
        })
        await tx.auditLog.delete({ where: { id: log.id } })
      }),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects UPDATE on Message', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property } = await seedLease(tx)
          const thread = await tx.thread.create({
            // `key` is Thread's deterministic identity (R-017). Any unique
            // string does here - this test is about the append-only trigger
            // on Message, not about thread resolution.
            data: {
              key: `test:leak:${property.id}`,
              propertyId: property.id,
              subject: 'Leak',
            },
          })
          const message = await tx.message.create({
            data: {
              threadId: thread.id,
              channel: 'SMS',
              direction: 'INBOUND',
              body: 'Water everywhere',
              sentAt: new Date('2026-01-03T23:11:00Z'),
            },
          })
          await tx.message.update({
            where: { id: message.id },
            data: { body: 'Never mind' },
          })
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/append-only/)
  })

  // Delivery status legitimately changes after a message is sent, which is
  // why it lives on its own mutable table instead of on the evidence row.
  it('allows MessageDelivery to be updated', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property } = await seedLease(tx)
          const thread = await tx.thread.create({
            data: { key: `test:delivery:${property.id}`, propertyId: property.id },
          })
          const message = await tx.message.create({
            data: {
              threadId: thread.id,
              channel: 'SMS',
              direction: 'OUTBOUND',
              body: 'Tech arrives 9am',
              sentAt: new Date('2026-01-04T14:00:00Z'),
              delivery: { create: {} },
            },
          })
          const updated = await tx.messageDelivery.update({
            where: { messageId: message.id },
            data: { status: 'DELIVERED', deliveredAt: new Date() },
          })
          expect(updated.status).toBe('DELIVERED')
          throw new Rollback()
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(Rollback)
  })
})

describe('two-payer ledger shape', () => {
  // A voucher lease: the housing authority pays $1,400 of the $1,850 rent and
  // the tenant pays $450. Two Stripe customers, two subscriptions, one charge,
  // one lease balance. R-002 owns the shape; R-048 owns everything that knows
  // what a housing authority is.
  it('splits one charge across two payers and sums back to the charge', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property, lease } = await seedLease(tx)
          const tenant = await tx.tenant.create({
            data: { firstName: 'Dana', lastName: 'Reyes' },
          })

          const hapPayer = await tx.leasePayer.create({
            data: {
              leaseId: lease.id,
              propertyId: property.id,
              payerType: 'HOUSING_AUTHORITY',
              externalPayerName: 'Houston Housing Authority',
              portionCents: 140_000,
              stripeCustomerId: 'cus_test_hap',
              stripeSubscriptionId: 'sub_test_hap',
            },
          })
          const tenantPayer = await tx.leasePayer.create({
            data: {
              leaseId: lease.id,
              propertyId: property.id,
              payerType: 'TENANT',
              tenantId: tenant.id,
              portionCents: 45_000,
              stripeCustomerId: 'cus_test_tenant',
              stripeSubscriptionId: 'sub_test_tenant',
            },
          })

          const charge = await tx.charge.create({
            data: {
              propertyId: property.id,
              leaseId: lease.id,
              type: 'RENT',
              amountCents: 185_000,
              description: 'January rent',
              dueOn: new Date('2026-01-01'),
              allocations: {
                create: [
                  { leasePayerId: hapPayer.id, amountCents: 140_000 },
                  { leasePayerId: tenantPayer.id, amountCents: 45_000 },
                ],
              },
            },
            include: { allocations: true },
          })

          const allocated = charge.allocations.reduce(
            (sum, a) => sum + a.amountCents,
            0,
          )
          expect(allocated).toBe(charge.amountCents)
          expect(charge.allocations).toHaveLength(2)

          throw new Rollback()
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(Rollback)
  })

  it('refuses two allocations of the same charge to the same payer', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property, lease } = await seedLease(tx)
          const payer = await tx.leasePayer.create({
            data: {
              leaseId: lease.id,
              propertyId: property.id,
              payerType: 'TENANT',
            },
          })
          const charge = await tx.charge.create({
            data: {
              propertyId: property.id,
              leaseId: lease.id,
              type: 'RENT',
              amountCents: 185_000,
              description: 'January rent',
              dueOn: new Date('2026-01-01'),
            },
          })
          await tx.payerAllocation.create({
            data: {
              chargeId: charge.id,
              leasePayerId: payer.id,
              amountCents: 185_000,
            },
          })
          // Double-posting the same payer's share is the bug this unique
          // constraint exists to stop.
          await tx.payerAllocation.create({
            data: {
              chargeId: charge.id,
              leasePayerId: payer.id,
              amountCents: 185_000,
            },
          })
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/[Uu]nique constraint/)
  })
})

describe('task queue idempotency', () => {
  // D-9: idempotent creation on (type, subjectId, businessDate), so a nightly
  // job that runs twice - or a retry after a partial failure - produces one
  // task, not two.
  it('refuses a duplicate task for the same type, subject and business date', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const { property, lease } = await seedLease(tx)
          const data = {
            propertyId: property.id,
            type: 'delinquency.day_5',
            subjectType: 'Lease',
            subjectId: lease.id,
            businessDate: new Date('2026-01-06'),
            title: 'Follow up on unpaid January rent',
          }
          await tx.task.create({ data })
          await tx.task.create({ data })
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/[Uu]nique constraint/)
  })
})
