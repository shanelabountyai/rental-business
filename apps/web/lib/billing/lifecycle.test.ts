import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billingRunRows, runBillingSweep, syncLease, syncLeasePayer } from './lifecycle.ts'
import { provisionLeaseBilling } from './provision.ts'

// The subscription lifecycle against a real database (D-11, R-036).
//
// The assertions that matter: a tenancy that ended stops billing, a rent
// change reaches Stripe, and neither happens to a lease that is merely a
// draft. Against the simulator `getSubscription` reads our own row, so these
// prove the DECISION and the RECORDING - the Stripe call itself is proved by
// the driver's own tests and, ultimately, by a test-mode key.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string

beforeAll(async () => {
  const stamp = `lifecycle-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '6 Lifecycle Loop',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sid', lastName: `Cycle-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedLease(overrides: { status?: string; rentCents?: number } = {}) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: (overrides.status ?? 'ACTIVE') as never,
      startsOn: new Date('2026-01-01'),
      endsOn: new Date('2026-12-31'),
      rentCents: overrides.rentCents ?? 150_000,
      activatedAt: new Date('2025-12-20T18:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId, isPrimary: true },
  })
  return lease
}

describe('syncLeasePayer', () => {
  it('reports agreement and records the sync when nothing needs doing', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: lease.id } })

    const result = await syncLeasePayer(payer.id)
    expect(result.outcome).toBe('in_sync')

    // The breadcrumb the Billing Runs screen reads.
    const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
    expect(after.lastSyncedAt).not.toBeNull()
    expect(after.lastSyncAction).toBe('in_sync')
    expect(after.lastSyncError).toBeNull()
  })

  it('CANCELS when the tenancy has ended', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    await prisma.lease.update({
      where: { id: lease.id },
      data: { status: 'ENDED', moveOutAt: new Date('2026-08-31T12:00:00Z') },
    })
    const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: lease.id } })

    const result = await syncLeasePayer(payer.id)
    expect(result.outcome).toBe('cancelled')
  })

  it('re-prices when the rent has moved', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    await prisma.lease.update({ where: { id: lease.id }, data: { rentCents: 165_000 } })
    const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: lease.id } })

    const result = await syncLeasePayer(payer.id)
    expect(result.outcome).toBe('price_updated')
    expect(result.reason).toMatch(/165000c/)
  })

  it('PAUSES a payer under a collection hold (PAY-12)', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: lease.id } })
    await prisma.leasePayer.update({
      where: { id: payer.id },
      data: { collectionPaused: true },
    })

    const result = await syncLeasePayer(payer.id)
    expect(result.outcome).toBe('paused')
    expect(result.reason).toMatch(/collection hold/)
  })

  it('provisions a live lease that somehow has no subscription', async () => {
    const lease = await seedLease()
    const payer = await prisma.leasePayer.create({
      data: { leaseId: lease.id, propertyId, payerType: 'TENANT', tenantId },
    })

    const result = await syncLeasePayer(payer.id)
    expect(result.outcome).toBe('provisioned')
    const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
    expect(after.stripeSubscriptionId).toMatch(/^sub_/)
  })

  it('does NOTHING for a draft lease', async () => {
    // Opening a subscription for a tenancy that may never happen would bill
    // somebody who has not moved in.
    const lease = await seedLease({ status: 'DRAFT' })
    const payer = await prisma.leasePayer.create({
      data: { leaseId: lease.id, propertyId, payerType: 'TENANT', tenantId },
    })

    const result = await syncLeasePayer(payer.id)
    expect(result.outcome).toBe('not_applicable')
    const after = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
    expect(after.stripeSubscriptionId).toBeNull()
  })

  it('writes an audit entry naming the provider', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    await prisma.lease.update({ where: { id: lease.id }, data: { rentCents: 170_000 } })
    const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: lease.id } })
    await syncLeasePayer(payer.id)

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: lease.id, action: 'billing.subscription_synced' },
      orderBy: { occurredAt: 'desc' },
    })
    expect((entry.after as { provider?: string })?.provider).toBe('simulated')
  })
})

describe('syncLease', () => {
  it('syncs every payer on the lease', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    const results = await syncLease(lease.id)
    expect(results).toHaveLength(1)
    expect(results[0]!.leaseId).toBe(lease.id)
  })

  it('returns nothing for a lease with no payer', async () => {
    const lease = await seedLease({ status: 'DRAFT' })
    expect(await syncLease(lease.id)).toEqual([])
  })
})

describe('runBillingSweep', () => {
  it('checks live leases and reports what changed', async () => {
    const lease = await seedLease()
    await provisionLeaseBilling(lease.id)
    await prisma.lease.update({ where: { id: lease.id }, data: { rentCents: 175_000 } })

    const run = await runBillingSweep({ propertyIds: [propertyId] })
    expect(run.checked).toBeGreaterThan(0)
    const mine = run.results.find((r) => r.leaseId === lease.id)
    expect(mine?.outcome).toBe('price_updated')
  })

  it('leaves a long-ended tenancy alone once it has no subscription', async () => {
    // Asking Stripe about a lease that ended two years ago, every night,
    // forever, is an API bill for no information.
    const lease = await seedLease({ status: 'ENDED' })
    const payer = await prisma.leasePayer.create({
      data: { leaseId: lease.id, propertyId, payerType: 'TENANT', tenantId },
    })
    const run = await runBillingSweep({ propertyIds: [propertyId] })
    expect(run.results.find((r) => r.leasePayerId === payer.id)).toBeUndefined()
  })
})

describe('billingRunRows', () => {
  it('puts failures and never-synced rows first', async () => {
    // A billing screen whose problems are in the middle of the list is one
    // nobody scans.
    const failed = await seedLease()
    await provisionLeaseBilling(failed.id)
    const failedPayer = await prisma.leasePayer.findFirstOrThrow({
      where: { leaseId: failed.id },
    })
    await prisma.leasePayer.update({
      where: { id: failedPayer.id },
      data: { lastSyncedAt: new Date(), lastSyncAction: 'failed', lastSyncError: 'boom' },
    })

    const healthy = await seedLease()
    await provisionLeaseBilling(healthy.id)
    const healthyPayer = await prisma.leasePayer.findFirstOrThrow({
      where: { leaseId: healthy.id },
    })
    await syncLeasePayer(healthyPayer.id)

    const rows = await billingRunRows([propertyId])
    const failedIndex = rows.findIndex((r) => r.id === failedPayer.id)
    const healthyIndex = rows.findIndex((r) => r.id === healthyPayer.id)
    expect(failedIndex).toBeLessThan(healthyIndex)
  })

  it('returns nothing for an empty scope', async () => {
    expect(await billingRunRows([])).toEqual([])
  })
})

describe('the daily sweep job', () => {
  it('registers itself into R-006’s SCHEDULED_JOBS', async () => {
    // Registration is a side effect of import, and the one place that
    // imports it is registrations.ts - so a job that stopped registering
    // would simply never run, silently, with nothing to notice. Imported
    // directly here rather than through registrations.ts, because that
    // module pulls in every other consumer too (the trap R-023 documented).
    const { SCHEDULED_JOBS } = await import('@/lib/jobs/runner.ts')
    const before = SCHEDULED_JOBS.length
    await import('./sweep-job.ts')

    const job = SCHEDULED_JOBS.find((j) => j.type === 'billing.sweep')
    expect(job, 'billing.sweep should be registered').toBeTruthy()
    expect(SCHEDULED_JOBS.length).toBeGreaterThan(before - 1)
    // Property-local, like every scheduled job in this product (D-3).
    expect(job!.localHour).toBeGreaterThanOrEqual(0)
    expect(job!.localHour).toBeLessThan(24)
  })
})
