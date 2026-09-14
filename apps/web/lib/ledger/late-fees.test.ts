import { randomUUID } from 'node:crypto'
import { wallClockToUtc } from '@rental/core/scheduling'
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

describe('assessLateFees — unlinked rent (R-050b)', () => {
  // ORDINARY SUBSCRIPTION RENT, THE WAY PRODUCTION ACTUALLY WRITES IT
  // (mirrors e2e/rent-roll.spec.ts's own `unlinkedRentTenancy` fixture).
  // D-11/D-40 mint no Charge row for the subscription's own rent line - the
  // webhook posts an UNLINKED ledger entry, so the only record of when it
  // was due at all is `Lease.rentDueDay`. This is the case `assessLateFees`
  // could not see before this item: no Charge row means it was never even
  // in the query.
  //
  // A FRESH LEASE PER TEST, deliberately - unlike the dated-charge tests
  // above, which isolate by anchoring each fee to its own Charge id, an
  // unlinked-rent fee is anchored to the LEASE's whole balance. Sharing one
  // lease across tests would let one test's unpaid rent inflate another's
  // balance and due-cycle math.
  const leaseIds: string[] = []
  const tenantIds: string[] = []

  afterAll(async () => {
    await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
    await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  })

  async function seedUnlinkedLease() {
    const stamp = `latefee-unlinked-${randomUUID().slice(0, 8)}`
    const tenant = await prisma.tenant.create({
      data: { firstName: 'Robin', lastName: `Unlinked-${stamp}` },
    })
    tenantIds.push(tenant.id)
    const lease = await prisma.lease.create({
      data: {
        propertyId,
        unitId,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
        rentDueDay: 1,
      },
    })
    leaseIds.push(lease.id)
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: lease.id,
        propertyId,
        payerType: 'TENANT',
        tenantId: tenant.id,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
    return { leaseId: lease.id, payerId: payer.id }
  }

  async function unlinkedRentDue(leaseId: string, dueOn: string, amountCents = 150_000) {
    // NO CHARGE ROW - `chargeId: null` is the whole point of the fixture.
    //
    // 09:00 PROPERTY-LOCAL, NOT UTC MIDNIGHT, because that is what production
    // writes: `occurredAt` is the `invoice.finalized` instant and
    // `billingCycleAnchor` puts the anchor at `BILLING_HOUR_LOCAL`. R-205
    // reads the period's due date back out of it, and a UTC-midnight fixture
    // would land on the previous local day for every US zone - the fixture
    // shaped unlike the real input that D-132 is about.
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        chargeId: null,
        type: 'CHARGE',
        amountCents,
        occurredAt: wallClockToUtc(`${dueOn}T09:00`, 'America/Chicago'),
        description: 'Rent',
      },
    })
  }

  it('assesses a fee on rent that has NO Charge row at all — the gap this item closes', async () => {
    const { leaseId } = await seedUnlinkedLease()
    await unlinkedRentDue(leaseId, '2026-03-01')
    const result = await assessLateFees(propertyId, new Date('2026-03-20T12:00:00Z'))

    expect(result.chargesAssessed).toBeGreaterThan(0)
    const fee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
    })
    expect(fee.amountCents).toBeGreaterThan(0)
    expect(fee.assessedForDueOn).not.toBeNull()
    expect(fee.jurisdictionRuleId).not.toBeNull()
    expect(fee.stripeInvoiceItemId).not.toBeNull()
  }, 20_000)

  it('does NOT charge twice for the same day', async () => {
    const { leaseId } = await seedUnlinkedLease()
    await unlinkedRentDue(leaseId, '2026-04-01')
    const at = new Date('2026-04-20T12:00:00Z')
    await assessLateFees(propertyId, at)
    const afterFirst = await prisma.charge.aggregate({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
      _sum: { amountCents: true },
      _count: true,
    })

    await assessLateFees(propertyId, at)
    const afterSecond = await prisma.charge.aggregate({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
      _sum: { amountCents: true },
      _count: true,
    })
    expect(afterSecond._count).toBe(afterFirst._count)
    expect(afterSecond._sum.amountCents).toBe(afterFirst._sum.amountCents)
  }, 20_000)

  it('charges the INCREMENT on a later day, never the cumulative total', async () => {
    const { leaseId } = await seedUnlinkedLease()
    await unlinkedRentDue(leaseId, '2026-05-01')
    await assessLateFees(propertyId, new Date('2026-05-10T12:00:00Z'))
    const firstTotal =
      (await prisma.charge.aggregate({
        where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
        _sum: { amountCents: true },
      }))._sum.amountCents ?? 0

    await assessLateFees(propertyId, new Date('2026-05-20T12:00:00Z'))
    const secondTotal =
      (await prisma.charge.aggregate({
        where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
        _sum: { amountCents: true },
      }))._sum.amountCents ?? 0

    expect(secondTotal).toBeGreaterThanOrEqual(firstTotal)
    expect(secondTotal).toBeLessThan(firstTotal * 2)
  }, 20_000)

  it('leaves a fully paid unlinked rent balance alone', async () => {
    const { leaseId, payerId } = await seedUnlinkedLease()
    await unlinkedRentDue(leaseId, '2026-06-01')
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId: payerId,
        chargeId: null,
        type: 'PAYMENT',
        amountCents: -150_000,
        description: 'Paid',
        occurredAt: new Date('2026-06-02T12:00:00Z'),
      },
    })

    await assessLateFees(propertyId, new Date('2026-06-20T12:00:00Z'))
    expect(
      await prisma.charge.count({ where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' } }),
    ).toBe(0)
  }, 20_000)

  it('assesses the monthly rent of a MID-MONTH MOVE-IN, whose proration is itself a RENT charge (R-205)', async () => {
    // THE DEFECT THIS ITEM EXISTS FOR. This pass used to select leases
    // holding no `RENT` Charge at all - and `chargeMoveInProration` writes
    // exactly one at activation, so every lease that did not start on its
    // rent due day was excluded from this pass for the life of the tenancy.
    // Pass 1 reached only the proration, found it paid, and moved on: the
    // ordinary rent underneath was assessed by neither pass, for ever.
    const { leaseId, payerId } = await seedUnlinkedLease()
    const proration = await prisma.charge.create({
      data: {
        propertyId,
        leaseId,
        type: 'RENT',
        amountCents: 50_000,
        description: 'Part month — 10 of 31 days',
        dueOn: new Date('2026-01-15T00:00:00.000Z'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId: payerId,
        chargeId: proration.id,
        type: 'CHARGE',
        amountCents: 50_000,
        description: 'Part month',
        occurredAt: new Date('2026-01-15T15:00:00.000Z'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId: payerId,
        chargeId: proration.id,
        type: 'PAYMENT',
        amountCents: -50_000,
        description: 'Paid the part month, on time',
        occurredAt: new Date('2026-01-16T15:00:00.000Z'),
      },
    })
    await unlinkedRentDue(leaseId, '2026-02-01')

    await assessLateFees(propertyId, new Date('2026-02-20T12:00:00Z'))

    // The proration was paid, so pass 1 correctly charges nothing on it.
    expect(await prisma.charge.count({ where: { assessedOnChargeId: proration.id } })).toBe(0)
    // February's rent is what is actually late, and it now attracts a fee.
    const fee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
    })
    expect(fee.assessedForDueOn?.toISOString().slice(0, 10)).toBe('2026-02-01')
    expect(fee.amountCents).toBeGreaterThan(0)
  }, 20_000)

  it('computes a percentage fee on EACH PERIOD, never on the whole arrears (R-205)', async () => {
    // The mirror half. This pass used to hand `lateFeeFor` the whole ledger
    // balance as `outstandingCents`, so the seeded Texas rule (10% of the
    // outstanding, capped at 12% of a month's rent) produced ONE fee of
    // $180 - the cap - for two unpaid months, having tried to charge 10% of
    // $3,000. Allocated per period it is two fees of $150, and neither is
    // computed off a figure that includes the other period or any fee
    // already assessed.
    const { leaseId } = await seedUnlinkedLease()
    await unlinkedRentDue(leaseId, '2026-03-01')
    await unlinkedRentDue(leaseId, '2026-04-01')

    await assessLateFees(propertyId, new Date('2026-04-20T12:00:00Z'))

    const fees = await prisma.charge.findMany({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
      orderBy: { assessedForDueOn: 'asc' },
    })
    expect(fees.map((fee) => fee.assessedForDueOn?.toISOString().slice(0, 10))).toEqual([
      '2026-03-01',
      '2026-04-01',
    ])
    // 10% of one month's $1,500, twice - not 12% of $1,500 once.
    expect(fees.map((fee) => fee.amountCents)).toEqual([15_000, 15_000])
  }, 20_000)

  it('a distinct later cycle is not silently netted against an earlier one already assessed', async () => {
    // The exact risk `assessedForDueOn` exists to close: March's debt gets a
    // fee, March is then paid off, and May goes unpaid too - May's fee must
    // not be suppressed by March's already having "used up" the allowance.
    const { leaseId, payerId } = await seedUnlinkedLease()
    await unlinkedRentDue(leaseId, '2026-03-01')
    await assessLateFees(propertyId, new Date('2026-03-20T12:00:00Z'))
    const marchFee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE' },
    })

    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId: payerId,
        chargeId: null,
        type: 'PAYMENT',
        amountCents: -150_000,
        description: 'Paid March',
        occurredAt: new Date('2026-03-25T12:00:00Z'),
      },
    })
    await unlinkedRentDue(leaseId, '2026-05-01')
    await assessLateFees(propertyId, new Date('2026-05-20T12:00:00Z'))

    const mayFee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnLeaseId: leaseId, type: 'LATE_FEE', id: { not: marchFee.id } },
    })
    expect(mayFee.amountCents).toBeGreaterThan(0)
    expect(mayFee.assessedForDueOn?.toISOString().slice(0, 10)).toBe('2026-05-01')
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
