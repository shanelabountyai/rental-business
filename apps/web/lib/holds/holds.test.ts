import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assessLateFees } from '@/lib/ledger/late-fees.ts'
import { pastGraceLeaseIds } from '@/lib/payments/rent-roll.ts'
import { activeHoldsForLease, leasesHalted } from './queries.ts'

// Lease holds, against a real database (RISK-11, RISK-12; R-084).
//
// ==========================================================================
// THE GUARDS, NOT THE TABLE. packages/core/holds/holds.test.ts already
// asserts the effect table itself; what cannot be proved there is that the
// nightly late-fee sweep and the bulk chase actually consult it.
//
// That is the failure worth a database test: both guards are one `continue`
// inside a loop somebody will refactor, and both fail SILENTLY in the
// direction that does harm — a fee accrues against a bankruptcy stay, a
// chase goes out to a tenancy that is protected, and nothing on any screen
// says so. A green unit test on the effect table would still pass.
// ==========================================================================

let entityId: string
let propertyId: string
let staffId: string
const leaseIds: string[] = []
const tenantIds: string[] = []

beforeAll(async () => {
  const stamp = `holds-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '9 Hold Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const staff = await prisma.staffUser.create({
    data: { email: `holds-${randomUUID()}@example.test`, name: 'Hold Placer' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // Retire rather than delete: a LeaseHold points at a StaffUser with
  // onDelete: Restrict, and the audit trail these tests write is append-only
  // (CLAUDE.md's "test cleanup cannot delete a row an append-only table
  // references").
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

/// A tenancy with overdue rent, billable, and nothing else going on.
async function seedOverdueLease(dueOn: string) {
  const stamp = randomUUID().slice(0, 8)
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Alex', lastName: `Held-${stamp}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      rentDueDay: 1,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId: tenant.id,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  const rent = await prisma.charge.create({
    data: {
      propertyId,
      leaseId: lease.id,
      type: 'RENT',
      amountCents: 150_000,
      description: 'Rent',
      dueOn: new Date(`${dueOn}T00:00:00.000Z`),
    },
  })
  // The projection of that charge. `assessLateFees` works off the Charge row
  // and does not need this; `pastGraceLeaseIds` reads the BALANCE, and a
  // tenancy with an open charge and no ledger is reported current — see
  // `delinquencyFor`'s first branch. Type CHARGE, so the late-fee sweep's
  // "what has already been applied" filter correctly ignores it.
  await prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId: lease.id,
      chargeId: rent.id,
      type: 'CHARGE',
      amountCents: 150_000,
      description: 'Rent',
      occurredAt: new Date(`${dueOn}T00:00:00.000Z`),
    },
  })
  return { leaseId: lease.id, rentChargeId: rent.id }
}

async function placeHold(leaseId: string, type: 'BANKRUPTCY' | 'DO_NOT_CONTACT') {
  return prisma.leaseHold.create({
    data: { leaseId, propertyId, type, reason: 'test fixture', placedByStaffId: staffId },
  })
}

describe('leasesHalted', () => {
  it('answers by EFFECT, not by hold type', async () => {
    const { leaseId } = await seedOverdueLease('2026-02-01')
    await placeHold(leaseId, 'DO_NOT_CONTACT')

    // `do_not_contact` carries halt_dunning and suppress_marketing, and
    // deliberately NOT halt_late_fees — the asymmetry core's own test names.
    expect([...(await leasesHalted([leaseId], 'halt_dunning'))]).toEqual([leaseId])
    expect([...(await leasesHalted([leaseId], 'suppress_marketing'))]).toEqual([leaseId])
    expect([...(await leasesHalted([leaseId], 'halt_late_fees'))]).toEqual([])
  })

  it('touches the database not at all for an empty input', async () => {
    expect((await leasesHalted([], 'halt_dunning')).size).toBe(0)
  })

  it('stops counting a hold once it is lifted', async () => {
    const { leaseId } = await seedOverdueLease('2026-02-01')
    const hold = await placeHold(leaseId, 'BANKRUPTCY')
    expect((await activeHoldsForLease(leaseId)).length).toBe(1)

    await prisma.leaseHold.update({
      where: { id: hold.id },
      data: { liftedAt: new Date(), liftedByStaffId: staffId, liftReason: 'stay lifted' },
    })

    expect((await activeHoldsForLease(leaseId)).length).toBe(0)
    expect((await leasesHalted([leaseId], 'halt_late_fees')).size).toBe(0)
  })
})

describe('the late-fee sweep', () => {
  it('assesses an unheld tenancy and skips a held one in the same run', async () => {
    // BOTH IN ONE ASSERTION, on purpose. A test that only proved the held
    // lease got no fee would pass just as well if the sweep were broken
    // outright — which is the way a guard like this usually breaks.
    const unheld = await seedOverdueLease('2026-03-01')
    const held = await seedOverdueLease('2026-03-01')
    await placeHold(held.leaseId, 'BANKRUPTCY')

    const result = await assessLateFees(propertyId, new Date('2026-03-20T12:00:00Z'))

    expect(result.heldLeases).toBeGreaterThanOrEqual(1)
    expect(
      await prisma.charge.count({
        where: { assessedOnChargeId: unheld.rentChargeId, type: 'LATE_FEE' },
      }),
    ).toBeGreaterThan(0)
    expect(
      await prisma.charge.count({
        where: { assessedOnChargeId: held.rentChargeId, type: 'LATE_FEE' },
      }),
    ).toBe(0)
  }, 30_000)

  it('does not stop a hold that halts only contact', async () => {
    // `do_not_contact` is the one type whose meter keeps running. If this
    // ever goes green-by-accident the asymmetry has been flattened.
    const { leaseId, rentChargeId } = await seedOverdueLease('2026-04-01')
    await placeHold(leaseId, 'DO_NOT_CONTACT')

    await assessLateFees(propertyId, new Date('2026-04-20T12:00:00Z'))

    expect(
      await prisma.charge.count({ where: { assessedOnChargeId: rentChargeId, type: 'LATE_FEE' } }),
    ).toBeGreaterThan(0)
  }, 30_000)
})

describe('the bulk chase', () => {
  it('drops a held tenancy from the past-grace set the reminder sends to', async () => {
    const unheld = await seedOverdueLease('2026-05-01')
    const held = await seedOverdueLease('2026-05-01')
    await placeHold(held.leaseId, 'BANKRUPTCY')

    const chaseable = await pastGraceLeaseIds(
      [unheld.leaseId, held.leaseId],
      new Date('2026-05-25T12:00:00Z'),
    )

    expect(chaseable.has(unheld.leaseId)).toBe(true)
    expect(chaseable.has(held.leaseId)).toBe(false)
  }, 30_000)
})
