import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assessNsfFee } from './nsf-fees.ts'

// The returned-payment fee (PAY-02, R-039a; D-4, D-12).
//
// `nsfFeeFor` was written in R-039, tested in core, and callable by nothing -
// there was not even a column to hold what the lease provides for. So the
// tenant's returned-payment notice carried a comment explaining that it stays
// silent about a fee "rather than quoting a fee that does not exist". These
// tests cover the push that ends that.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let leaseId: string
let leasePayerId: string
// Its own state code, minted per run. Shared with nothing: a constant here
// collides with `e2e/notice-to-vacate.spec.ts`, which writes a statewide rule
// of its own, and `rulesFor` fetches EVERY rule for a state before choosing -
// so the cap this test asserts could come from the other file's row. The
// nullable-jurisdiction unique constraint refuses nothing (R-108).
const CAPPED_STATE = `Q${randomUUID().slice(0, 8)}`

const ruleIds: string[] = []
const propertyIds: string[] = []

beforeAll(async () => {
  const stamp = `nsffee-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '6 Bounce Street',
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
    data: { firstName: 'Nia', lastName: `Bounce-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      // What THIS lease provides for. The statute clamps it; it does not
      // supply it.
      nsfFeeCents: 2_500,
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
  // The rule is test-only configuration for a state nothing else uses, so it
  // is genuinely deletable - unlike the tenants and properties below, which
  // append-only rows reference.
  await prisma.charge.deleteMany({ where: { jurisdictionRuleId: { in: ruleIds } } })
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/** A settled-then-returned payment for the fee to answer to. */
async function returnedPayment(amountCents = 150_000) {
  return prisma.payment.create({
    data: {
      leaseId,
      propertyId,
      leasePayerId,
      amountCents,
      channel: 'ACH',
      status: 'REVERSED',
      receivedAt: new Date('2026-03-05T12:00:00Z'),
      stripePaymentIntentId: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    },
  })
}

describe('assessNsfFee', () => {
  it('raises the fee, pushes it, and stamps the rule version onto it', async () => {
    const payment = await returnedPayment()
    const result = await assessNsfFee({ leaseId, propertyId, leasePayerId, paymentId: payment.id })

    expect(result.reason).toBe('raised')
    expect(result.amountCents).toBe(2_500)

    const fee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnPaymentId: payment.id, type: 'NSF_FEE' },
    })
    // D-12: core decided the amount and Stripe was handed a finished number.
    expect(fee.stripeInvoiceItemId).not.toBeNull()
    // D-4: which version of the law permitted it, and at what ceiling. The
    // first question in a dispute, unreconstructable from today's row.
    expect(fee.jurisdictionRuleId).not.toBeNull()
    // The description defends the charge rather than merely naming it.
    expect(fee.description).toContain('lease provides')
  }, 20_000)

  it('dates the fee in the PROPERTY\'s calendar, not UTC\'s', async () => {
    // 8pm on 5 March in Houston is 02:00 on the 6th in UTC. Reading the UTC
    // clock for a date-only column made the fee fall due tomorrow, and
    // `daysPastDue` counts grace and the late fee from that date - so the
    // defect moved money, not just a label. Same shape as R-042.
    const payment = await returnedPayment()
    await assessNsfFee({
      leaseId,
      propertyId,
      leasePayerId,
      paymentId: payment.id,
      now: new Date('2026-03-06T02:00:00.000Z'),
    })

    const fee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnPaymentId: payment.id, type: 'NSF_FEE' },
      select: { dueOn: true },
    })
    expect(fee.dueOn?.toISOString().slice(0, 10)).toBe('2026-03-05')
  }, 20_000)

  it('charges ONCE however many times Stripe redelivers', async () => {
    // A tenant charged twice for one bounced payment is a support call that
    // starts from a position of being wrong.
    const payment = await returnedPayment()
    await assessNsfFee({ leaseId, propertyId, leasePayerId, paymentId: payment.id })
    const second = await assessNsfFee({ leaseId, propertyId, leasePayerId, paymentId: payment.id })

    expect(second.reason).toBe('already_raised')
    const count = await prisma.charge.count({
      where: { assessedOnPaymentId: payment.id, type: 'NSF_FEE' },
    })
    expect(count).toBe(1)
  }, 20_000)

  it('the DATABASE refuses a second fee, not just the code path', async () => {
    // The read-then-write check above is a nicety; two concurrent webhook
    // deliveries would both pass it. The partial unique index is what
    // actually holds.
    const payment = await returnedPayment()
    await assessNsfFee({ leaseId, propertyId, leasePayerId, paymentId: payment.id })

    await expect(
      prisma.charge.create({
        data: {
          propertyId,
          leaseId,
          type: 'NSF_FEE',
          amountCents: 2_500,
          description: 'A second fee for the same returned payment',
          dueOn: new Date('2026-03-06T00:00:00.000Z'),
          assessedOnPaymentId: payment.id,
        },
      }),
    ).rejects.toThrow()
  }, 20_000)

  it('raises NOTHING when the lease is silent', async () => {
    // The normal case, not a gap: a fee the tenant never agreed to is
    // unenforceable at exactly the moment somebody needs to enforce it.
    const quiet = await prisma.lease.create({
      data: {
        propertyId,
        unitId,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 120_000,
        nsfFeeCents: null,
      },
    })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: quiet.id,
        propertyId,
        payerType: 'TENANT',
        tenantId,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
    const payment = await prisma.payment.create({
      data: {
        leaseId: quiet.id,
        propertyId,
        leasePayerId: payer.id,
        amountCents: 120_000,
        channel: 'ACH',
        status: 'REVERSED',
        receivedAt: new Date('2026-03-05T12:00:00Z'),
        stripePaymentIntentId: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      },
    })

    const result = await assessNsfFee({
      leaseId: quiet.id,
      propertyId,
      leasePayerId: payer.id,
      paymentId: payment.id,
    })

    expect(result.reason).toBe('lease_silent')
    expect(result.chargeId).toBeNull()
    expect(
      await prisma.charge.count({ where: { leaseId: quiet.id, type: 'NSF_FEE' } }),
    ).toBe(0)
  }, 20_000)

  it('CLAMPS a lease fee above the statutory ceiling, and says so', async () => {
    // D-4 in miniature: the lease supplies the amount, the statute caps it,
    // and the record has to show BOTH numbers or the cap is unprovable.
    //
    // Its own state and its own rule, because the shipped Texas rule sets no
    // NSF ceiling - the first version of this test read that rule, found the
    // cap null, and returned early having asserted nothing. A test that
    // silently does nothing is worse than no test: it reports as covered.
    const capped = await prisma.jurisdictionRule.create({
      data: {
        state: CAPPED_STATE,
        jurisdiction: null,
        version: 1,
        effectiveFrom: new Date('2020-01-01'),
        graceDays: 3,
        lateFeeType: 'NONE',
        depositEscrowRequired: false,
        depositInterestRequired: false,
        justCauseRequired: false,
        paymentAllocationOrder: ['RENT'],
        rubsPermitted: true,
        nsfFeePermitted: true,
        nsfFeeMaxCents: 3_000,
      },
    })
    ruleIds.push(capped.id)

    const cappedProperty = await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `capped-${randomUUID().slice(0, 6)}`,
        addressLine1: '8 Ceiling Court',
        city: 'Nowhere',
        state: CAPPED_STATE,
        postalCode: '00001',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    propertyIds.push(cappedProperty.id)
    const cappedUnit = await prisma.unit.create({
      data: { propertyId: cappedProperty.id, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
    })
    const greedy = await prisma.lease.create({
      data: {
        propertyId: cappedProperty.id,
        unitId: cappedUnit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 120_000,
        // The lease asks for more than the state allows.
        nsfFeeCents: 9_500,
      },
    })
    const payer = await prisma.leasePayer.create({
      data: {
        leaseId: greedy.id,
        propertyId: cappedProperty.id,
        payerType: 'TENANT',
        tenantId,
        stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    })
    const payment = await prisma.payment.create({
      data: {
        leaseId: greedy.id,
        propertyId: cappedProperty.id,
        leasePayerId: payer.id,
        amountCents: 120_000,
        channel: 'ACH',
        status: 'REVERSED',
        receivedAt: new Date('2026-03-05T12:00:00Z'),
        stripePaymentIntentId: `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      },
    })

    const result = await assessNsfFee({
      leaseId: greedy.id,
      propertyId: cappedProperty.id,
      leasePayerId: payer.id,
      paymentId: payment.id,
    })

    expect(result.amountCents).toBe(3_000)
    const fee = await prisma.charge.findFirstOrThrow({
      where: { assessedOnPaymentId: payment.id },
    })
    // Both numbers on the record: what the lease asked for, and what the
    // state allowed. "We charged $30 because Texas caps it" is a sentence
    // that survives a dispute; "$30" alone is not.
    expect(fee.description).toContain('$95.00')
    expect(fee.description).toContain('capped at $30.00')
  }, 20_000)
})
