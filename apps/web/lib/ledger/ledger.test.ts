import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { leaseBalanceCents, leaseStatement, outstandingCharges } from './queries.ts'
import { reconcileLedger } from './reconcile.ts'

// The ledger projection against a real database (PAY-03, D-11, R-035).
//
// The assertion that matters most: reconciliation catches a projection that
// was LOST - an event claimed and marked projected with no ledger row to
// show for it. That is money Stripe reported which is missing from the
// books, and nothing else in the product would ever notice.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let leaseId: string
let leasePayerId: string

beforeAll(async () => {
  const stamp = `ledger-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '4 Ledger Lane',
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
    data: { firstName: 'Lee', lastName: `Ledger-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      endsOn: new Date('2026-12-31'),
      rentCents: 150_000,
    },
  })
  leaseId = lease.id
  const payer = await prisma.leasePayer.create({
    data: { leaseId, propertyId, payerType: 'TENANT', tenantId },
  })
  leasePayerId = payer.id
})

afterAll(async () => {
  // LedgerEntry is append-only and its foreign keys are RESTRICT, so
  // everything a projected row points at stays. Only what carries no ledger
  // reference is cleaned up, deactivated rather than deleted.
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

async function entry(
  amountCents: number,
  type: string,
  occurredAt: string,
  options: { description?: string; stripeEventId?: string } = {},
) {
  return prisma.ledgerEntry.create({
    data: {
      propertyId,
      leaseId,
      leasePayerId,
      type: type as never,
      amountCents,
      description: options.description ?? type,
      occurredAt: new Date(occurredAt),
      stripeEventId: options.stripeEventId ?? null,
    },
  })
}

const scope = () => ({ propertyIds: [propertyId], legalEntityIds: [entityId] }) as never

describe('leaseStatement', () => {
  it('carries a running balance in chronological order', async () => {
    await entry(150_000, 'CHARGE', '2026-02-01T12:00:00Z', { description: 'February rent' })
    await entry(-50_000, 'PAYMENT', '2026-02-05T12:00:00Z', { description: 'Part payment' })

    const result = await leaseStatement(leaseId, scope())
    expect(result).not.toBeNull()
    const february = result!.lines.filter((l) => l.occurredAt < new Date('2026-03-01'))
    expect(february.map((l) => l.runningBalanceCents)).toEqual([150_000, 100_000])
    expect(result!.balanceCents).toBe(100_000)
  })

  it('refuses a lease outside the caller’s scope', async () => {
    // Out of scope and does not exist are indistinguishable, same as every
    // other scoped read in this product.
    const other = { propertyIds: [], legalEntityIds: [] } as never
    expect(await leaseStatement(leaseId, other)).toBeNull()
  })

  it('agrees with the balance-only read', async () => {
    // Deliberately the same arithmetic over the same rows rather than a
    // separate SQL SUM, so the two can never disagree about what a balance
    // is.
    const statement = await leaseStatement(leaseId, scope())
    expect(await leaseBalanceCents(leaseId)).toBe(statement!.balanceCents)
  })
})

describe('outstandingCharges', () => {
  it('reports what is left on a partially-paid charge', async () => {
    const charge = await prisma.charge.create({
      data: {
        propertyId,
        leaseId,
        type: 'RENT',
        amountCents: 150_000,
        description: 'March rent',
        dueOn: new Date('2026-03-01'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId,
        chargeId: charge.id,
        type: 'CHARGE',
        amountCents: 150_000,
        description: 'March rent',
        occurredAt: new Date('2026-03-01T12:00:00Z'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId,
        chargeId: charge.id,
        type: 'PAYMENT',
        amountCents: -120_000,
        description: 'Part payment',
        occurredAt: new Date('2026-03-04T12:00:00Z'),
      },
    })

    const outstanding = await outstandingCharges(leaseId)
    const march = outstanding.find((c) => c.id === charge.id)
    expect(march?.outstandingCents).toBe(30_000)
    expect(march?.dueOn).toBe('2026-03-01')
  })

  it('leaves out a charge that has been settled', async () => {
    const charge = await prisma.charge.create({
      data: {
        propertyId,
        leaseId,
        type: 'LATE_FEE',
        amountCents: 5_000,
        description: 'Late fee',
        dueOn: new Date('2026-03-06'),
      },
    })
    await prisma.ledgerEntry.create({
      data: {
        propertyId,
        leaseId,
        leasePayerId,
        chargeId: charge.id,
        type: 'PAYMENT',
        amountCents: -5_000,
        description: 'Paid',
        occurredAt: new Date('2026-03-07T12:00:00Z'),
      },
    })

    const outstanding = await outstandingCharges(leaseId)
    expect(outstanding.map((c) => c.id)).not.toContain(charge.id)
  })
})

describe('reconcileLedger', () => {
  it('reports NOTHING when the log and the projection agree', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    const occurredAt = new Date()
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.payment_succeeded',
        outcome: 'projected',
        occurredAt,
      },
    })
    await entry(-150_000, 'PAYMENT', occurredAt.toISOString(), { stripeEventId: eventId })

    const report = await reconcileLedger()
    expect(report.drift.filter((d) => d.stripeEventId === eventId)).toEqual([])
  })

  it('CATCHES a projection that was lost', async () => {
    // The most serious drift: money Stripe reported, missing from the books,
    // and nothing else would ever notice.
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.payment_succeeded',
        outcome: 'projected',
        occurredAt: new Date(),
      },
    })

    const report = await reconcileLedger()
    const found = report.drift.find((d) => d.stripeEventId === eventId)
    expect(found?.kind).toBe('projected_but_missing')
  })

  it('CATCHES a lost REVERSAL, which the old type-keyed check could not', async () => {
    // The drift that was invisible. `invoice.payment_failed` writes a
    // REVERSAL when it is an ACH return against a settled payment (R-039)
    // and nothing when it is a first decline - so keying on the event type
    // said "no row expected" in both cases, and a lost reversal (money
    // credited back that should not have been) went unnoticed by the check
    // built to catch exactly that.
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.payment_failed',
        outcome: 'projected',
        detail: 'payment_returned',
        occurredAt: new Date(),
      },
    })

    const report = await reconcileLedger()
    expect(report.drift.find((d) => d.stripeEventId === eventId)?.kind).toBe(
      'projected_but_missing',
    )
  })

  it('CATCHES a lost CHARGE, the half added by R-040b', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.finalized',
        outcome: 'projected',
        detail: 'charge_posted',
        occurredAt: new Date(),
      },
    })

    const report = await reconcileLedger()
    expect(report.drift.find((d) => d.stripeEventId === eventId)?.kind).toBe(
      'projected_but_missing',
    )
  })

  it('does NOT expect a row for a failure that recorded no money movement', async () => {
    // The other half of keying on the detail: a first decline projects a
    // FAILED payment and no ledger row, and flagging that as drift would
    // make the report noisy enough to stop being read.
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.payment_failed',
        outcome: 'projected',
        detail: 'payment_failed',
        occurredAt: new Date(),
      },
    })

    const report = await reconcileLedger()
    expect(report.drift.filter((d) => d.stripeEventId === eventId)).toEqual([])
  })

  it('catches a claim the pipeline died in the middle of', async () => {
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.payment_succeeded',
        // Still `received` - claimed, never resolved either way.
        outcome: 'received',
        occurredAt: new Date(),
      },
    })

    const report = await reconcileLedger()
    expect(report.drift.find((d) => d.stripeEventId === eventId)?.kind).toBe('stuck_claim')
  })

  it('catches a ledger row naming an event nobody has', async () => {
    // Either the log was truncated, or something wrote to the projection
    // directly - which D-11 forbids outright.
    const orphanEventId = `evt_orphan_${randomUUID().replace(/-/g, '')}`
    const row = await entry(-1_000, 'PAYMENT', new Date().toISOString(), {
      stripeEventId: orphanEventId,
    })

    const report = await reconcileLedger()
    const found = report.drift.find((d) => d.ledgerEntryId === row.id)
    expect(found?.kind).toBe('orphan_entry')
  })

  it('ALARMS by writing to the append-only trail, not just logging', async () => {
    // A projection that has drifted cannot be quietly corrected, so the
    // discrepancy needs the same permanence as the rows it is about.
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: eventId,
        type: 'invoice.payment_succeeded',
        outcome: 'projected',
        occurredAt: new Date(),
      },
    })

    const before = await prisma.auditLog.count({ where: { action: 'ledger.drift_detected' } })
    await reconcileLedger()
    expect(
      await prisma.auditLog.count({ where: { action: 'ledger.drift_detected' } }),
    ).toBeGreaterThan(before)
  })

  it('says out loud that it did NOT check against Stripe', async () => {
    // "Reconciled" meaning two different things depending on configuration
    // is exactly how a check stops being trusted.
    const report = await reconcileLedger()
    expect(report.externalChecked).toBe(false)
  })

  it('ignores rows older than its window', async () => {
    // A nightly job that gets slower every month is one somebody disables.
    const old = `evt_${randomUUID().replace(/-/g, '')}`
    await prisma.processedStripeEvent.create({
      data: {
        stripeEventId: old,
        type: 'invoice.payment_succeeded',
        outcome: 'projected',
        occurredAt: new Date('2020-01-01'),
      },
    })

    const report = await reconcileLedger(new Date(), 30)
    expect(report.drift.find((d) => d.stripeEventId === old)).toBeUndefined()
  })
})
