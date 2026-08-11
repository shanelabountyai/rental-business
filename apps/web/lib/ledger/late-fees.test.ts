import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assessLateFees } from './late-fees.ts'
import { waiverPatternByTenant } from './waiver-report.ts'

// Late-fee assessment against a real database (PAY-04, R-040).
//
// The assertion that matters most is the second one: assessing twice in a day
// must not charge twice, and assessing a DAILY rule on consecutive days must
// charge the increment rather than the cumulative total. `lateFeeFor()`
// answers "what is owed in total", so a naive nightly job compounds a $10/day
// fee into $60 by day three.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let leaseId: string

beforeAll(async () => {
  const stamp = `latefee-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '5 Late Lane',
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
    data: { firstName: 'Sam', lastName: `Late-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  leaseId = lease.id
  await prisma.leaseTenant.create({ data: { leaseId, tenantId } })
  await prisma.leasePayer.create({
    data: {
      leaseId,
      propertyId,
      payerType: 'TENANT',
      tenantId,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function overdueRent(dueOn: string) {
  return prisma.charge.create({
    data: {
      propertyId,
      leaseId,
      type: 'RENT',
      amountCents: 150_000,
      description: 'Rent',
      dueOn: new Date(`${dueOn}T00:00:00.000Z`),
    },
  })
}

describe('assessLateFees', () => {
  it('assesses an overdue rent charge and stamps the rule version onto it', async () => {
    const rent = await overdueRent('2026-03-01')
    const result = await assessLateFees(propertyId, new Date('2026-03-20T12:00:00Z'))

    expect(result.chargesAssessed).toBeGreaterThan(0)
    const fee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnChargeId: rent.id, type: 'LATE_FEE' },
    })
    expect(fee.amountCents).toBeGreaterThan(0)
    // WHICH VERSION of the law produced this number - the first question in
    // any dispute, and unreconstructable from today's row.
    expect(fee.jurisdictionRuleId).not.toBeNull()
    expect(fee.stripeInvoiceItemId).not.toBeNull()
    // The description defends the charge rather than just naming it.
    expect(fee.description).toContain('past due')
  }, 20_000)

  it('does NOT charge twice for the same day', async () => {
    // The idempotency that makes a nightly job safe to re-run.
    const rent = await overdueRent('2026-04-01')
    const at = new Date('2026-04-20T12:00:00Z')
    await assessLateFees(propertyId, at)
    const afterFirst = await prisma.charge.aggregate({
      where: { assessedOnChargeId: rent.id },
      _sum: { amountCents: true },
      _count: true,
    })

    await assessLateFees(propertyId, at)
    const afterSecond = await prisma.charge.aggregate({
      where: { assessedOnChargeId: rent.id },
      _sum: { amountCents: true },
      _count: true,
    })
    expect(afterSecond._count).toBe(afterFirst._count)
    expect(afterSecond._sum.amountCents).toBe(afterFirst._sum.amountCents)
  }, 20_000)

  it('charges the INCREMENT on a later day, never the cumulative total', async () => {
    // The trap: lateFeeFor() returns the total owed as of a date. A job that
    // charged that figure nightly would compound it.
    const rent = await overdueRent('2026-05-01')
    await assessLateFees(propertyId, new Date('2026-05-10T12:00:00Z'))
    const firstTotal =
      (await prisma.charge.aggregate({
        where: { assessedOnChargeId: rent.id },
        _sum: { amountCents: true },
      }))._sum.amountCents ?? 0

    await assessLateFees(propertyId, new Date('2026-05-20T12:00:00Z'))
    const secondTotal =
      (await prisma.charge.aggregate({
        where: { assessedOnChargeId: rent.id },
        _sum: { amountCents: true },
      }))._sum.amountCents ?? 0

    // Whatever the Texas rule is, the running total after the second
    // assessment must equal what the rule says is owed at that date - never
    // the sum of two cumulative figures.
    expect(secondTotal).toBeGreaterThanOrEqual(firstTotal)
    expect(secondTotal).toBeLessThan(firstTotal * 2)
  }, 20_000)

  it('leaves a fully paid rent charge alone', async () => {
    const rent = await overdueRent('2026-06-01')
    const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId } })
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId: payer.id,
        chargeId: rent.id,
        type: 'PAYMENT',
        amountCents: -150_000,
        description: 'Paid',
        occurredAt: new Date('2026-06-02T12:00:00Z'),
      },
    })

    await assessLateFees(propertyId, new Date('2026-06-20T12:00:00Z'))
    expect(await prisma.charge.count({ where: { assessedOnChargeId: rent.id } })).toBe(0)
  }, 20_000)
})

describe('waiverPatternByTenant (PAY-04, fair housing)', () => {
  it('reports tenants with NO waivers too, because they are half the pattern', async () => {
    // A report of waivers alone shows only generosity and hides its
    // distribution, which is the opposite of what a fair-housing review
    // needs.
    const rows = await waiverPatternByTenant([propertyId])
    const row = rows.find((r) => r.tenantId === tenantId)
    expect(row).toBeDefined()
    expect(row!.feesAssessed).toBeGreaterThan(0)
    expect(row!.waivedShare).toBe(0)
  }, 20_000)

  it('counts a waived fee against the share', async () => {
    const fee = await prisma.charge.findFirstOrThrow({
      where: { leaseId, type: 'LATE_FEE', waivedAt: null },
    })
    await prisma.charge.update({
      where: { id: fee.id },
      data: { waivedAt: new Date(), waiveReason: 'first late payment in two years' },
    })

    const rows = await waiverPatternByTenant([propertyId])
    const row = rows.find((r) => r.tenantId === tenantId)!
    expect(row.feesWaived).toBe(1)
    expect(row.waivedShare).toBeGreaterThan(0)
  }, 20_000)
})
