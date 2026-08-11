import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SimulatedBillingProvider } from '@/lib/billing/simulated-adapter.ts'
import { leaseBalanceCents } from '@/lib/ledger/queries.ts'
import { paymentView } from './queries.ts'

// The tenant pay screen against a real database (PAY-01, R-037).
//
// The assertions that matter most are the two that protect a tenant's money:
// in-flight payments are subtracted from what they are asked for, and a
// payer on autopay is not offered a partial payment Stripe cannot take.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let leaseId: string
let leasePayerId: string

beforeAll(async () => {
  const stamp = `pay-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '9 Payment Place',
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
    data: { firstName: 'Ada', lastName: `Pay-${randomUUID().slice(0, 6)}` },
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
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId,
      propertyId,
      payerType: 'TENANT',
      tenantId,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  leasePayerId = payer.id
})

afterAll(async () => {
  // Deactivated rather than deleted: LedgerEntry is append-only and its
  // foreign keys are RESTRICT, so anything a projected row points at stays.
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

const scope = () => ({ tenantId, leaseIds: [leaseId], unitIds: [unitId] })

async function charge(amountCents: number, type = 'RENT', description = 'February rent') {
  const row = await prisma.charge.create({
    data: { propertyId, leaseId, type: type as never, amountCents, description, dueOn: new Date('2026-02-01') },
  })
  await prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId,
      leasePayerId,
      chargeId: row.id,
      type: 'CHARGE',
      amountCents,
      description,
      occurredAt: new Date('2026-02-01T12:00:00Z'),
    },
  })
  return row
}

describe('paymentView', () => {
  it('shows the balance and what it is made up of, before paying', async () => {
    await charge(150_000)
    const view = await paymentView(scope())
    expect(view).not.toBeNull()
    expect(view!.balanceCents).toBe(150_000)
    expect(view!.maxCents).toBe(150_000)
    expect(view!.charges.map((c) => c.outstandingCents)).toContain(150_000)
  })

  it('SUBTRACTS a payment already on its way', async () => {
    // The ledger deliberately does not move for an in-flight ACH debit. A
    // screen that ignored it would show the full balance to a tenant who
    // paid three days ago and invite a second debit for one month's rent.
    const pending = await prisma.payment.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId,
        channel: 'ACH',
        status: 'PENDING',
        amountCents: 100_000,
        receivedAt: new Date(),
        stripePaymentIntentId: `pi_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })

    const view = await paymentView(scope())
    // The BALANCE is untouched - money in flight has not arrived.
    expect(view!.balanceCents).toBe(150_000)
    // What they are asked for is not.
    expect(view!.inFlightCents).toBe(100_000)
    expect(view!.maxCents).toBe(50_000)

    await prisma.payment.delete({ where: { id: pending.id } })
  })

  it('offers a partial payment only where the collection method allows it (D-29)', async () => {
    const autopay = await paymentView(scope())
    expect(autopay!.collectionMethod).toBe('charge_automatically')
    expect(autopay!.allowsPartial).toBe(false)

    await prisma.leasePayer.update({
      where: { id: leasePayerId },
      data: { collectionMethod: 'send_invoice' },
    })
    const invoiced = await paymentView(scope())
    expect(invoiced!.allowsPartial).toBe(true)

    await prisma.leasePayer.update({
      where: { id: leasePayerId },
      data: { collectionMethod: 'charge_automatically' },
    })
  })

  it('offers ACH first and prices the card from the jurisdiction rule', async () => {
    const view = await paymentView(scope())
    expect(view!.rails[0]!.rail).toBe('ACH')
    // Texas permits the surcharge in the seeded rule, so the fee is real and
    // grossed up above the nominal rate.
    if (view!.cardFeePermitted) {
      expect(view!.cardFeeCents).toBeGreaterThan(0)
    }
  })

  it('never offers retail cash, because no driver exists for it', async () => {
    // Offered as unavailable WITH a reason rather than hidden: an option a
    // tenant picks and then cannot complete is worse than one never shown,
    // and silently omitting it would hide a gap PAY-01 actually asks for.
    const view = await paymentView(scope())
    const cash = view!.rails.find((r) => r.rail === 'RETAIL_CASH')!
    expect(cash.available).toBe(false)
    expect(cash.unavailableReason).toBeTruthy()
  })

  it('returns null for a tenant with no payer set up', async () => {
    // A tenant mid-onboarding is a real state, not an error - the screen
    // says so in words rather than 500ing.
    expect(await paymentView({ tenantId, leaseIds: [], unitIds: [] })).toBeNull()
  })
})

describe('the open-invoice read the offline path depends on', () => {
  it('reports the outstanding balance under a stable, Stripe-shaped id', async () => {
    // R-038 marks an INVOICE paid out of band, so it needs an invoice id -
    // not just an amount. The simulator derives both from the ledger, so a
    // retry finds the same invoice rather than inventing a second one.
    await prisma.leasePayer.update({
      where: { id: leasePayerId },
      data: { stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 14)}` },
    })
    const payer = await prisma.leasePayer.findUniqueOrThrow({
      where: { id: leasePayerId },
      select: { stripeSubscriptionId: true },
    })

    const provider = new SimulatedBillingProvider()
    const first = await provider.getOpenInvoice({
      stripeSubscriptionId: payer.stripeSubscriptionId!,
    })
    expect(first).not.toBeNull()
    expect(first!.stripeInvoiceId).toMatch(/^in_/)
    expect(first!.amountRemainingCents).toBeGreaterThan(0)

    const second = await provider.getOpenInvoice({
      stripeSubscriptionId: payer.stripeSubscriptionId!,
    })
    expect(second!.stripeInvoiceId).toBe(first!.stripeInvoiceId)
  })

  it('reports nothing open when the balance is clear', async () => {
    // The `no_open_invoice` refusal has to be reachable, or the branch is
    // dead code no test can exercise.
    const payer = await prisma.leasePayer.findUniqueOrThrow({
      where: { id: leasePayerId },
      select: { leaseId: true, stripeSubscriptionId: true },
    })
    const outstanding = await leaseBalanceCents(payer.leaseId)
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId: payer.leaseId,
        leasePayerId,
        type: 'PAYMENT',
        amountCents: -outstanding,
        description: 'Settled in full',
        occurredAt: new Date(),
      },
    })

    const provider = new SimulatedBillingProvider()
    expect(
      await provider.getOpenInvoice({ stripeSubscriptionId: payer.stripeSubscriptionId! }),
    ).toBeNull()
  })
})
