import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers the real job into this file's own
// SCHEDULED_JOBS - same isolation auto-finalize-job.test.ts already relies on.
import './deposit-clearing-job.ts'

// The deposit-clearing job (INSP-01, R-069): a Deposit liability row and a
// "release the codes" Task appear once the deposit charge is fully paid AND
// the money is safe to act on - certified funds immediately, a personal
// check only after its hold.

const CHICAGO = 'America/Chicago'
const DEPOSIT_CENTS = 200_000

let entityId: string
let propertyId: string
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const payerIds: string[] = []
const chargeIds: string[] = []
const paymentIds: string[] = []

beforeAll(async () => {
  const stamp = `depositclear-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterEach(async () => {
  // LedgerEntry is append-only by trigger (CLAUDE.md), and Lease/Charge/
  // Payment all carry a `Restrict` FK from it - once a test writes a real
  // ledger entry, none of the rows behind it can be hard-deleted again.
  // Deposit and Task carry no such reference, so those are the only rows
  // worth clearing between tests; everything else just accumulates under
  // this file's own throwaway property, deactivated whole in `afterAll`.
  await prisma.deposit.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.task.deleteMany({ where: { subjectId: { in: leaseIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId } })
  leaseIds.length = 0
  unitIds.length = 0
  tenantIds.length = 0
  payerIds.length = 0
  chargeIds.length = 0
  paymentIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function makeLease(unique: string) {
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: 'Renter', email: `pat-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-08-01T00:00:00Z'),
      rentCents: 150_000,
      depositCents: DEPOSIT_CENTS,
      depositArrangement: 'CASH',
    },
  })
  leaseIds.push(lease.id)
  const payer = await prisma.leasePayer.create({
    data: { leaseId: lease.id, propertyId, payerType: 'TENANT', tenantId: tenant.id },
  })
  payerIds.push(payer.id)
  return { unit, lease, payer }
}

/// A DEPOSIT charge fully offset by one payment on the given channel.
async function depositChargedAndPaid(
  leaseId: string,
  payerId: string,
  channel: string,
  receivedAt: Date,
) {
  const charge = await prisma.charge.create({
    data: {
      propertyId,
      leaseId,
      type: 'DEPOSIT',
      amountCents: DEPOSIT_CENTS,
      description: 'Security deposit',
      dueOn: new Date('2026-08-01T00:00:00Z'),
    },
  })
  chargeIds.push(charge.id)
  const payment = await prisma.payment.create({
    data: {
      propertyId,
      leaseId,
      leasePayerId: payerId,
      channel: channel as never,
      status: 'SETTLED',
      amountCents: DEPOSIT_CENTS,
      receivedAt,
    },
  })
  paymentIds.push(payment.id)
  await prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId,
      leasePayerId: payerId,
      type: 'CHARGE',
      amountCents: DEPOSIT_CENTS,
      description: 'Security deposit',
      occurredAt: receivedAt,
      chargeId: charge.id,
    },
  })
  await prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId,
      leasePayerId: payerId,
      type: 'PAYMENT',
      amountCents: -DEPOSIT_CENTS,
      description: 'Security deposit paid',
      occurredAt: receivedAt,
      chargeId: charge.id,
      paymentId: payment.id,
    },
  })
  return charge
}

async function runAt(isoInstant: string) {
  return runDueJobs(new Date(isoInstant), { propertyIds: [propertyId] })
}

describe('the deposit-clearing job', () => {
  it('creates the Deposit and a task once a certified-funds payment settles', async () => {
    const { lease, payer } = await makeLease('a')
    await depositChargedAndPaid(lease.id, payer.id, 'MONEY_ORDER', new Date('2026-08-01T12:00:00Z'))

    await runAt('2026-08-02T12:00:00Z')

    const deposit = await prisma.deposit.findFirst({ where: { leaseId: lease.id } })
    expect(deposit?.heldCents).toBe(DEPOSIT_CENTS)

    const task = await prisma.task.findFirst({
      where: { subjectId: lease.id, type: 'lease.deposit_cleared' },
    })
    expect(task).not.toBeNull()
  })

  it('withholds the Deposit while a personal check is still inside its hold', async () => {
    const { lease, payer } = await makeLease('b')
    await depositChargedAndPaid(lease.id, payer.id, 'OFFLINE_CHECK', new Date('2026-08-01T12:00:00Z'))

    await runAt('2026-08-03T12:00:00Z') // 2 days later, hold is 5 days

    const deposit = await prisma.deposit.findFirst({ where: { leaseId: lease.id } })
    expect(deposit).toBeNull()
  })

  it('creates the Deposit for a personal check once its hold has elapsed', async () => {
    const { lease, payer } = await makeLease('c')
    await depositChargedAndPaid(lease.id, payer.id, 'OFFLINE_CHECK', new Date('2026-08-01T12:00:00Z'))

    await runAt('2026-08-07T12:00:00Z') // 6 days later

    const deposit = await prisma.deposit.findFirst({ where: { leaseId: lease.id } })
    expect(deposit?.heldCents).toBe(DEPOSIT_CENTS)
  })

  it('is idempotent - never creates a second Deposit row on a later run', async () => {
    const { lease, payer } = await makeLease('d')
    await depositChargedAndPaid(lease.id, payer.id, 'OFFLINE_CASH', new Date('2026-08-01T12:00:00Z'))

    await runAt('2026-08-02T12:00:00Z')
    await runAt('2026-08-03T12:00:00Z')

    const deposits = await prisma.deposit.findMany({ where: { leaseId: lease.id } })
    expect(deposits).toHaveLength(1)
  })
})
