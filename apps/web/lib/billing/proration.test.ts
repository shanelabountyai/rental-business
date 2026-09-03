import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chargeMoveInProration, chargeMoveOutProration } from './proration.ts'

// Charging the part month (PAY-08, R-042; D-12).
//
// The core arithmetic is covered in packages/core/billing/proration.test.ts.
// What is asserted here is the wiring: that the boundary comes from the same
// anchor Stripe was given, that the charge carries its own arithmetic, and
// that a tenant cannot be billed twice for their first days.

let entityId: string
let propertyId: string
let unitId: string
// Move-out proration's anchor search is instant-sensitive around the
// billing hour (09:00 property-local, see anchor.ts) - a second property on
// 'UTC' makes that arithmetic reasonable to pin in a test without also
// reasoning about America/Chicago's own offset.
let utcPropertyId: string
let utcUnitId: string
let tenantId: string
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `proration-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '9 Partial Way',
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
  const utcProperty = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house-utc`,
      addressLine1: '10 Departure Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'UTC',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  utcPropertyId = utcProperty.id
  const utcUnit = await prisma.unit.create({
    data: { propertyId: utcPropertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  utcUnitId = utcUnit.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: `Partial-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: [propertyId, utcPropertyId] } },
    data: { active: false },
  })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedLease(args: {
  startsOn: string
  rentDueDay: number
  method?: 'ACTUAL' | 'BANKER30'
  withCustomer?: boolean
}) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date(`${args.startsOn}T00:00:00.000Z`),
      rentCents: 150_000,
      rentDueDay: args.rentDueDay,
      prorationMethod: args.method ?? 'ACTUAL',
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId } })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId,
      stripeCustomerId:
        args.withCustomer === false
          ? null
          : `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  return lease
}

async function seedMoveOutLease(args: {
  moveOutAt: Date
  rentDueDay: number
  method?: 'ACTUAL' | 'BANKER30'
  withCustomer?: boolean
}) {
  const lease = await prisma.lease.create({
    data: {
      propertyId: utcPropertyId,
      unitId: utcUnitId,
      status: 'ENDED',
      startsOn: new Date('2025-01-01T00:00:00.000Z'),
      moveOutAt: args.moveOutAt,
      rentCents: 150_000,
      rentDueDay: args.rentDueDay,
      prorationMethod: args.method ?? 'ACTUAL',
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId } })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: utcPropertyId,
      payerType: 'TENANT',
      tenantId,
      stripeCustomerId:
        args.withCustomer === false
          ? null
          : `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  return lease
}

describe('chargeMoveOutProration', () => {
  it('credits the unoccupied tail and shows the arithmetic on the charge', async () => {
    // Moves out 20 March (noon UTC, well clear of the 09:00 billing hour),
    // next due day 1 April: 21st-31st is 11 unoccupied days of a 31-day
    // month. $1,500 x 11/31 = $532.258..., rounded to $532.26.
    const lease = await seedMoveOutLease({
      moveOutAt: new Date('2026-03-20T12:00:00.000Z'),
      rentDueDay: 1,
    })
    const result = await chargeMoveOutProration(lease.id)

    expect(result.reason).toBe('credited')
    expect(result.amountCents).toBe(-53_226)

    const charge = await prisma.charge.findFirstOrThrow({ where: { leaseId: lease.id } })
    // RENT, not a bespoke type - it's rent already paid for and not lived,
    // and typing it otherwise would drop it out of every rent-versus-fees
    // split the product already makes.
    expect(charge.type).toBe('RENT')
    expect(charge.amountCents).toBe(-53_226)
    expect(charge.description).toContain('Move-out credit')
    expect(charge.description).toContain('11/31 days')
    // D-12: core decided the amount, Stripe was handed a finished number -
    // negative, its own mechanism for a credit (same as `waiveCharge`).
    expect(charge.stripeInvoiceItemId).not.toBeNull()

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Charge', entityId: charge.id, action: 'ledger.adjusted' },
    })
    expect(audit.reason).toContain('11/31 days')
  }, 20_000)

  it('credits NOTHING when moving out exactly on the next due day', async () => {
    // 08:00 UTC, before the 09:00 billing hour: the period beginning that
    // same day has not been billed yet, so there is nothing to give back.
    const lease = await seedMoveOutLease({
      moveOutAt: new Date('2026-04-01T08:00:00.000Z'),
      rentDueDay: 1,
    })
    const result = await chargeMoveOutProration(lease.id)

    expect(result.reason).toBe('no_credit')
    expect(await prisma.charge.count({ where: { leaseId: lease.id } })).toBe(0)
  }, 20_000)

  it('credits a tenant ONCE, however often it runs', async () => {
    // A status transition can be re-run and a nightly resync exists;
    // crediting the same unoccupied days twice would be a real dollar bug on
    // the way OUT the door instead of in.
    const lease = await seedMoveOutLease({
      moveOutAt: new Date('2026-03-20T12:00:00.000Z'),
      rentDueDay: 1,
    })
    await chargeMoveOutProration(lease.id)
    const second = await chargeMoveOutProration(lease.id)

    expect(second.reason).toBe('already_credited')
    expect(await prisma.charge.count({ where: { leaseId: lease.id } })).toBe(1)
  }, 20_000)

  it('honours the 30-day method when the lease says so', async () => {
    const lease = await seedMoveOutLease({
      moveOutAt: new Date('2026-02-20T12:00:00.000Z'),
      rentDueDay: 1,
      method: 'BANKER30',
    })
    const result = await chargeMoveOutProration(lease.id)

    // 8 unoccupied days at $50/day = $400.00, even though February is 28.
    expect(result.amountCents).toBe(-40_000)
    const charge = await prisma.charge.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(charge.description).toContain('30-day month')
  }, 20_000)

  it('uses the move-out month length, not the following one', async () => {
    // 8 days of a 28-day February is $428.57. Dividing by March's 31 would
    // undercredit by about $27.
    const lease = await seedMoveOutLease({
      moveOutAt: new Date('2026-02-20T12:00:00.000Z'),
      rentDueDay: 1,
    })
    const result = await chargeMoveOutProration(lease.id)
    expect(result.amountCents).toBe(-42_857)
  }, 20_000)
})

describe('chargeMoveInProration', () => {
  it('charges the part month and shows the arithmetic on the charge', async () => {
    // 20 March to 1 April is 12 days of a 31-day month.
    const lease = await seedLease({ startsOn: '2026-03-20', rentDueDay: 1 })
    const result = await chargeMoveInProration(lease.id)

    expect(result.reason).toBe('charged')
    expect(result.amountCents).toBe(58_065)

    const charge = await prisma.charge.findFirstOrThrow({ where: { leaseId: lease.id } })
    // RENT, not a bespoke type: it IS rent, for fewer days, and typing it
    // otherwise would drop it out of every rent-versus-fees split.
    expect(charge.type).toBe('RENT')
    // PAY-08: the method is visible on the ledger, and the tenant can check
    // it against a calendar.
    expect(charge.description).toContain('12/31 days')
    expect(charge.description).toContain('$1,500.00')
    // D-12: core decided the amount, Stripe was handed a finished number.
    expect(charge.stripeInvoiceItemId).not.toBeNull()

    // AND IT IS AUDITED. `ledger.adjusted` is on REASON_REQUIRED, and this
    // call passed no reason - so `recordAudit` threw, the caller's `.catch`
    // logged it, and every part-month charge went on a tenant's ledger with
    // nothing recording who put it there. Nothing went red: the audit is
    // deliberately non-fatal, so the only symptom was a console line in a
    // seed log. Asserting the ROW, not the absence of a throw, is the whole
    // point - the throw was already being swallowed.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Charge', entityId: charge.id, action: 'ledger.adjusted' },
    })
    expect(audit.reason).toContain('12/31 days')
  }, 20_000)

  it('charges NOTHING when the lease starts on the rent due day', async () => {
    // A whole month is owed. A zero-amount line on a tenant's first invoice
    // is noise that has to be explained.
    const lease = await seedLease({ startsOn: '2026-04-01', rentDueDay: 1 })
    const result = await chargeMoveInProration(lease.id)

    expect(result.reason).toBe('whole_month')
    expect(await prisma.charge.count({ where: { leaseId: lease.id } })).toBe(0)
  }, 20_000)

  it('bills a tenant ONCE for their first days, however often it runs', async () => {
    // Provisioning is retried and resyncs happen. Being billed twice for the
    // days you moved in is the worst possible first impression of a new
    // landlord's systems.
    const lease = await seedLease({ startsOn: '2026-03-20', rentDueDay: 1 })
    await chargeMoveInProration(lease.id)
    const second = await chargeMoveInProration(lease.id)

    expect(second.reason).toBe('already_charged')
    expect(await prisma.charge.count({ where: { leaseId: lease.id } })).toBe(1)
  }, 20_000)

  it('honours the 30-day method when the lease says so', async () => {
    // 9 days of February: $482.14 on actual days, $450.00 on a flat 30. The
    // difference is real money and the lease decides which.
    const lease = await seedLease({
      startsOn: '2026-02-20',
      rentDueDay: 1,
      method: 'BANKER30',
    })
    const result = await chargeMoveInProration(lease.id)

    expect(result.amountCents).toBe(45_000)
    const charge = await prisma.charge.findFirstOrThrow({ where: { leaseId: lease.id } })
    // Says which method, so "9/30" beside a 28-day February does not read as
    // an arithmetic error.
    expect(charge.description).toContain('30-day month')
  }, 20_000)

  it('uses the move-in month length, not the following one', async () => {
    // The bug this pins end to end: 9 days of a 28-day February is $482.14.
    // Dividing by March's 31 would undercharge by $46.
    const lease = await seedLease({ startsOn: '2026-02-20', rentDueDay: 1 })
    const result = await chargeMoveInProration(lease.id)
    expect(result.amountCents).toBe(48_214)
  }, 20_000)
})
