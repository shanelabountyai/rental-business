import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { leaseBillingState, provisionLeaseBilling } from './provision.ts'
import { leaseBalanceCents } from '@/lib/ledger/queries.ts'
import { processStripeEvent } from './webhook.ts'

// Provisioning and the projection pipeline against a real database
// (D-11, R-034).
//
// The assertion that matters most: a RETRIED payment event must not credit
// the tenant twice. Stripe retries until it gets a 2xx and does not promise
// exactly-once delivery, and `LedgerEntry` is append-only - so a double
// projection is money that cannot be corrected by editing, only by a
// reversing entry somebody has to notice is needed.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `billing-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '1 Billing Boulevard',
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
    data: {
      firstName: 'Pat',
      lastName: `Payer-${randomUUID().slice(0, 6)}`,
      email: `pat-${randomUUID().slice(0, 8)}@example.test`,
    },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  // LedgerEntry is append-only (trigger-enforced) and its foreign keys are
  // RESTRICT, so a projected row pins the Payment, LeasePayer and Lease it
  // points at. That is the product working - the projection is evidence and
  // outlives what it refers to - so nothing below it is deleted either.
  // Only the roots that carry no ledger reference are cleaned up, and those
  // are deactivated rather than deleted, the same pattern every suite that
  // touches an append-only table has had to adopt.
  // ProcessedStripeEvent rows are deliberately NOT deleted. LedgerEntry is
  // append-only and cannot be, so deleting the event log while the entries
  // survive manufactures exactly the `orphan_entry` drift R-035's
  // reconciliation exists to detect - permanently, in whatever database the
  // suite ran against. Keeping them also mirrors the production invariant:
  // the log outlives, like the ledger it describes.
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedActiveLease(overrides: { withTenant?: boolean; rentDueDay?: number } = {}) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-03-01'),
      endsOn: new Date('2027-02-28'),
      rentCents: 150_000,
      rentDueDay: overrides.rentDueDay ?? 1,
      activatedAt: new Date('2026-02-20T18:00:00Z'),
    },
  })
  leaseIds.push(lease.id)
  if (overrides.withTenant !== false) {
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId, isPrimary: true },
    })
  }
  return lease
}

function invoiceEvent(overrides: {
  id?: string
  type?: string
  customer: string
  amountPaid?: number
  amountDue?: number
  invoiceId?: string
  paymentIntentId?: string
  created?: number
}) {
  const type = overrides.type ?? 'invoice.payment_succeeded'
  const id = overrides.id ?? `evt_${randomUUID().replace(/-/g, '')}`
  return {
    id,
    type,
    created: overrides.created ?? 1_800_000_000,
    data: {
      object: {
        id: overrides.invoiceId ?? `in_${randomUUID().slice(0, 12)}`,
        customer: overrides.customer,
        ...(type === 'invoice.payment_failed' || type === 'invoice.finalized'
          ? { amount_due: overrides.amountDue ?? 150_000 }
          : { amount_paid: overrides.amountPaid ?? 150_000 }),
        payment_intent: overrides.paymentIntentId ?? `pi_${randomUUID().slice(0, 12)}`,
      },
    },
  }
}

describe('provisionLeaseBilling', () => {
  it('creates a payer, a customer and a subscription for a live lease', async () => {
    const lease = await seedActiveLease()
    const result = await provisionLeaseBilling(lease.id)

    expect(result.outcome).toBe('provisioned')
    expect(result.stripeCustomerId).toMatch(/^cus_/)
    expect(result.stripeSubscriptionId).toMatch(/^sub_/)

    const payers = await leaseBillingState(lease.id)
    expect(payers).toHaveLength(1)
    expect(payers[0]).toMatchObject({
      payerType: 'TENANT',
      // Null means "the remainder" - how a single-payer lease works without
      // anybody keeping a number in sync with the rent.
      portionCents: null,
    })
  })

  it('is idempotent - a second call touches nothing', async () => {
    // The caller is a status transition somebody can perform twice.
    const lease = await seedActiveLease()
    const first = await provisionLeaseBilling(lease.id)
    const second = await provisionLeaseBilling(lease.id)

    expect(second.outcome).toBe('already_provisioned')
    expect(second.stripeCustomerId).toBe(first.stripeCustomerId)
    expect(second.stripeSubscriptionId).toBe(first.stripeSubscriptionId)
    expect(await prisma.leasePayer.count({ where: { leaseId: lease.id } })).toBe(1)
  })

  it('refuses to provision a lease with nobody on it', async () => {
    const lease = await seedActiveLease({ withTenant: false })
    expect((await provisionLeaseBilling(lease.id)).outcome).toBe('no_payer')
    expect(await prisma.leasePayer.count({ where: { leaseId: lease.id } })).toBe(0)
  })

  it('reports a partial first period without inventing the amount', async () => {
    // D-12 keeps the calculation ours (R-042), never Stripe's proration.
    // This only records that the question is open.
    const lease = await seedActiveLease({ rentDueDay: 15 })
    const result = await provisionLeaseBilling(lease.id)
    expect(result.firstPeriodPartial).toBe(true)
  })

  it('records the provider name on the audit entry', async () => {
    // A record that does not say whether it was Stripe or the simulator is
    // one somebody will misread the first time a staging database is
    // mistaken for production.
    const lease = await seedActiveLease()
    await provisionLeaseBilling(lease.id)
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: lease.id, action: 'billing.provisioned' },
    })
    expect((entry.after as { provider?: string })?.provider).toBe('simulated')
  })
})

describe('processStripeEvent', () => {
  async function provisionedLease() {
    const lease = await seedActiveLease()
    const result = await provisionLeaseBilling(lease.id)
    return { lease, customerId: result.stripeCustomerId! }
  }

  it('projects a successful payment into a Payment and a NEGATIVE ledger entry', async () => {
    const { lease, customerId } = await provisionedLease()
    const event = invoiceEvent({ customer: customerId, amountPaid: 150_000 })

    expect(await processStripeEvent(event)).toEqual({
      outcome: 'projected',
      detail: 'payment_succeeded',
    })

    const payment = await prisma.payment.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(payment.status).toBe('SETTLED')
    expect(payment.amountCents).toBe(150_000)

    const entries = await prisma.ledgerEntry.findMany({ where: { leaseId: lease.id } })
    expect(entries).toHaveLength(1)
    // NEGATIVE reduces what is owed. Inverting this would tell somebody they
    // owe rent they already paid.
    expect(entries[0]!.amountCents).toBe(-150_000)
    expect(entries[0]!.type).toBe('PAYMENT')
    expect(entries[0]!.stripeEventId).toBe(event.id)
  })

  it('POSTS A CHARGE when an invoice is finalized — the missing half of the ledger', async () => {
    // THE BUG THIS FIXES. Nothing in the product ever wrote a CHARGE entry:
    // the ledger carried payments and no charges, so a tenant who paid rent
    // went further into credit every month and the pay screen told them they
    // were ahead and owed nothing. Balances are computed from LedgerEntry
    // alone, so a single-entry ledger is a wrong balance everywhere.
    const { lease, customerId } = await provisionedLease()

    await processStripeEvent(
      invoiceEvent({ customer: customerId, type: 'invoice.finalized', amountDue: 150_000 }),
    )

    expect(await leaseBalanceCents(lease.id)).toBe(150_000)
    const entry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { leaseId: lease.id, type: 'CHARGE' },
    })
    // POSITIVE increases what is owed.
    expect(entry.amountCents).toBe(150_000)
    // A charge is not a payment - nobody has paid anything.
    expect(await prisma.payment.count({ where: { leaseId: lease.id } })).toBe(0)
  }, 20_000)

  it('completes the cycle: billed, then paid, lands at zero', async () => {
    // Double-entry end to end. Before the charge half existed this finished
    // at MINUS the rent, every month, forever.
    const { lease, customerId } = await provisionedLease()
    const invoiceId = `in_${randomUUID().slice(0, 12)}`

    await processStripeEvent(
      invoiceEvent({ customer: customerId, type: 'invoice.finalized', amountDue: 150_000, invoiceId }),
    )
    expect(await leaseBalanceCents(lease.id)).toBe(150_000)

    await processStripeEvent(
      invoiceEvent({ customer: customerId, amountPaid: 150_000, invoiceId }),
    )
    expect(await leaseBalanceCents(lease.id)).toBe(0)
  }, 20_000)

  it('ignores a finalized invoice with nothing due', async () => {
    // Fully covered by a credit balance. Nothing became owed, so nothing
    // goes on the ledger - projecting `total` instead of `amount_due` would
    // charge the tenant for something they were never asked to pay.
    const { lease, customerId } = await provisionedLease()
    const result = await processStripeEvent(
      invoiceEvent({ customer: customerId, type: 'invoice.finalized', amountDue: 0 }),
    )
    expect(result.outcome).toBe('ignored')
    expect(await leaseBalanceCents(lease.id)).toBe(0)
  }, 20_000)

  it('REVERSES a settled payment that the bank later returned (PAY-02)', async () => {
    // THE BUG THIS ITEM EXISTS TO FIX. An ACH debit gives "instant
    // provisional access" and takes up to four business days to confirm. The
    // return arrives as the same `invoice.payment_failed` event a first
    // decline produces - and treating it as a mere failed attempt leaves the
    // credit in place, so the tenant appears to have paid rent they have not.
    const { lease, customerId } = await provisionedLease()
    const paymentIntentId = `pi_${randomUUID().slice(0, 12)}`
    const invoiceId = `in_${randomUUID().slice(0, 12)}`

    await processStripeEvent(
      invoiceEvent({ customer: customerId, amountPaid: 150_000, paymentIntentId, invoiceId }),
    )
    expect(await leaseBalanceCents(lease.id)).toBe(-150_000)

    const returned = await processStripeEvent(
      invoiceEvent({
        customer: customerId,
        type: 'invoice.payment_failed',
        amountDue: 150_000,
        paymentIntentId,
        invoiceId,
      }),
    )
    expect(returned).toEqual({ outcome: 'projected', detail: 'payment_returned' })

    // The credit came back off, and the balance is what it was before.
    expect(await leaseBalanceCents(lease.id)).toBe(0)

    const payment = await prisma.payment.findFirstOrThrow({
      where: { stripePaymentIntentId: paymentIntentId },
    })
    expect(payment.status).toBe('REVERSED')
    expect(payment.reversedAt).not.toBeNull()

    // A REVERSING ENTRY that points at what it reverses - never an edit or a
    // delete, because LedgerEntry is append-only by trigger (D-11).
    const reversal = await prisma.ledgerEntry.findFirstOrThrow({
      where: { leaseId: lease.id, type: 'REVERSAL' },
    })
    expect(reversal.amountCents).toBe(150_000)
    expect(reversal.reversesId).not.toBeNull()
    // 20s, not the 5s default: this walks the REAL path twice - provision,
    // project a payment, then project its return - and the return sends the
    // tenant a locked-category notice on the way through. Scoped to its own
    // delivery ids, so it is genuinely this test's own work rather than a
    // global sweep; it is simply more work than five seconds buys.
  }, 20_000)

  it('does NOT reverse a first attempt that never settled', async () => {
    // The same event means two different things depending on history.
    // Nothing was credited here, so there is nothing to take back - and
    // writing a reversal would invent money the tenant never owed.
    const { lease, customerId } = await provisionedLease()
    await processStripeEvent(
      invoiceEvent({ customer: customerId, type: 'invoice.payment_failed', amountDue: 150_000 }),
    )

    expect(await leaseBalanceCents(lease.id)).toBe(0)
    expect(
      await prisma.ledgerEntry.count({ where: { leaseId: lease.id, type: 'REVERSAL' } }),
    ).toBe(0)
    const payment = await prisma.payment.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(payment.status).toBe('FAILED')
  }, 20_000)

  it('IGNORES a second delivery of the same return', async () => {
    // Stripe promises neither ordering nor exactly-once delivery, and
    // reversing twice would double what the tenant owes - in an append-only
    // ledger, where the only fix is another reversing entry.
    const { lease, customerId } = await provisionedLease()
    const paymentIntentId = `pi_${randomUUID().slice(0, 12)}`
    const invoiceId = `in_${randomUUID().slice(0, 12)}`

    await processStripeEvent(
      invoiceEvent({ customer: customerId, amountPaid: 150_000, paymentIntentId, invoiceId }),
    )
    await processStripeEvent(
      invoiceEvent({
        customer: customerId,
        type: 'invoice.payment_failed',
        paymentIntentId,
        invoiceId,
      }),
    )
    const second = await processStripeEvent(
      invoiceEvent({
        customer: customerId,
        type: 'invoice.payment_failed',
        paymentIntentId,
        invoiceId,
      }),
    )

    expect(second.outcome).toBe('ignored')
    expect(await leaseBalanceCents(lease.id)).toBe(0)
    expect(
      await prisma.ledgerEntry.count({ where: { leaseId: lease.id, type: 'REVERSAL' } }),
    ).toBe(1)
  }, 30_000)

  it('REFUSES to project the same event twice', async () => {
    // The single most important assertion in this file. Stripe retries until
    // it gets a 2xx; LedgerEntry is append-only, so a double projection is
    // money nobody can correct by editing.
    const { lease, customerId } = await provisionedLease()
    const event = invoiceEvent({ customer: customerId })

    const first = await processStripeEvent(event)
    const second = await processStripeEvent(event)

    expect(first.outcome).toBe('projected')
    expect(second).toEqual({ outcome: 'duplicate' })
    expect(await prisma.ledgerEntry.count({ where: { leaseId: lease.id } })).toBe(1)
    expect(await prisma.payment.count({ where: { leaseId: lease.id } })).toBe(1)
  })

  it('survives concurrent deliveries of the same event', async () => {
    // Not merely a retry - two deliveries in flight at once. The INSERT into
    // ProcessedStripeEvent is the lock, which a check-then-write would not
    // give.
    const { lease, customerId } = await provisionedLease()
    const event = invoiceEvent({ customer: customerId })

    const results = await Promise.all([
      processStripeEvent(event),
      processStripeEvent(event),
      processStripeEvent(event),
    ])

    expect(results.filter((r) => r.outcome === 'projected')).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(2)
    expect(await prisma.ledgerEntry.count({ where: { leaseId: lease.id } })).toBe(1)
  })

  it('records a failed payment WITHOUT moving the balance', async () => {
    // Nothing has changed about what is owed - the charge is still owed.
    const { lease, customerId } = await provisionedLease()
    const event = invoiceEvent({
      customer: customerId,
      type: 'invoice.payment_failed',
      amountDue: 150_000,
    })

    expect((await processStripeEvent(event)).outcome).toBe('projected')

    const payment = await prisma.payment.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(payment.status).toBe('FAILED')
    // No ledger movement at all - not a zero-amount row, which would be
    // noise in a table nobody can clean up.
    expect(await prisma.ledgerEntry.count({ where: { leaseId: lease.id } })).toBe(0)
  })

  it('projects a refund as a REVERSAL that re-opens the balance', async () => {
    const { lease, customerId } = await provisionedLease()
    const paymentIntentId = `pi_${randomUUID().slice(0, 12)}`

    await processStripeEvent(
      invoiceEvent({ customer: customerId, paymentIntentId, amountPaid: 150_000 }),
    )

    const refundId = `evt_${randomUUID().replace(/-/g, '')}`
    await processStripeEvent({
      id: refundId,
      type: 'charge.refunded',
      created: 1_800_100_000,
      data: {
        object: {
          id: `ch_${randomUUID().slice(0, 12)}`,
          customer: customerId,
          amount_refunded: 150_000,
          payment_intent: paymentIntentId,
        },
      },
    })

    const entries = await prisma.ledgerEntry.findMany({
      where: { leaseId: lease.id },
      orderBy: { occurredAt: 'asc' },
    })
    expect(entries.map((e) => e.amountCents)).toEqual([-150_000, 150_000])
    expect(entries[1]!.type).toBe('REVERSAL')

    // The SAME payment row moved to REFUNDED rather than a second one being
    // inserted - Payment is the state of one attempt, not an append-only log.
    const payments = await prisma.payment.findMany({ where: { leaseId: lease.id } })
    expect(payments).toHaveLength(1)
    expect(payments[0]!.status).toBe('REFUNDED')
    expect(payments[0]!.reversedAt).not.toBeNull()
  })

  it('IGNORES an event for a customer it has never heard of', async () => {
    // Guessing which lease it belongs to would write money against the wrong
    // tenancy, and retrying would not make the customer appear.
    const event = invoiceEvent({ customer: 'cus_nobody_knows_this_one' })
    const result = await processStripeEvent(event)
    expect(result.outcome).toBe('ignored')
    expect(result.detail).toContain('no lease payer')
  })

  it('ignores an event type nobody has thought about, and says so', async () => {
    const id = `evt_${randomUUID().replace(/-/g, '')}`
    const result = await processStripeEvent({
      id,
      type: 'customer.discount.created',
      created: 1_800_000_000,
      data: { object: { id: 'di_1', customer: 'cus_1' } },
    })
    expect(result.outcome).toBe('ignored')

    // Recorded anyway. "We saw it and deliberately did nothing" is the
    // answer to a support question that silence cannot give.
    const row = await prisma.processedStripeEvent.findUniqueOrThrow({
      where: { stripeEventId: id },
    })
    expect(row.outcome).toBe('ignored')
    expect(row.detail).toContain('customer.discount.created')
  })

  it('keeps a claim row even for an event it ignored', async () => {
    const { customerId } = await provisionedLease()
    const event = invoiceEvent({ customer: customerId })
    await processStripeEvent(event)
    const row = await prisma.processedStripeEvent.findUniqueOrThrow({
      where: { stripeEventId: event.id },
    })
    expect(row.outcome).toBe('projected')
    expect(row.occurredAt.toISOString()).toBe(new Date(event.created * 1000).toISOString())
  })
})
