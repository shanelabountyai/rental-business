import { randomUUID } from 'node:crypto'
import { recordAudit } from '@rental/core/audit'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { provisionLeaseBilling } from '@/lib/billing/provision.ts'
import { issuePayLink, verifyPayLink } from '@/lib/portal/pay-link.ts'
import { applyPaymentHold } from './legal-hold.ts'
import type { AuditWriter } from './legal-hold.ts'

// PAY-12's legal-action payment controls (R-047).
//
// ==========================================================================
// THE BACKLOG DEMANDS ONE TEST BY NAME: "this item must prove, with a test,
// that pausing actually stops Stripe."
//
// The reason it is singled out is the failure it prevents: "an autopay charge
// that fires the morning after a notice is served is a defect with legal
// consequences". A hold that only reaches Stripe on the nightly sweep is
// exactly that defect, and it would look completely correct on every screen.
// ==========================================================================

let entityId: string
let propertyId: string
let unitId: string
const tenantIds: string[] = []
let staffId: string

beforeAll(async () => {
  const stamp = `hold-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '3 Hold Street',
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
  const staff = await prisma.staffUser.create({
    data: { email: `hold-${randomUUID()}@example.test`, name: 'Hold Setter' },
  })
  staffId = staff.id
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/// A live, provisioned tenancy — so there is a real subscription for a hold
/// to actually pause.
async function seedProvisionedPayer() {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Alex',
      lastName: `Held-${randomUUID().slice(0, 6)}`,
      email: `held-${randomUUID().slice(0, 8)}@example.test`,
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      activatedAt: new Date('2025-12-20T18:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  await provisionLeaseBilling(lease.id)
  const payer = await prisma.leasePayer.findFirstOrThrow({ where: { leaseId: lease.id } })
  return { tenant, lease, payer }
}

const REASON = 'Notice to vacate served 2026-08-15; case opened.'

/// The audit writer, injected. Writes a REAL AuditLog row with a STAFF actor
/// rather than mocking — so the assertions below check the record an eviction
/// would actually be argued from, not a spy's arguments. The production
/// caller injects `lib/audit/index.ts`'s request-aware version, which adds
/// the actor's IP; that one cannot load under Vitest, which is why the writer
/// is a parameter at all.
const writeAudit: AuditWriter = async (input) => {
  await recordAudit(prisma, { ...input, actor: { type: 'STAFF', staffUserId: staffId } })
}

describe('applyPaymentHold', () => {
  it('PAUSES STRIPE SYNCHRONOUSLY — the test the backlog demands by name', async () => {
    const { payer } = await seedProvisionedPayer()

    // Before: Stripe is collecting.
    const before = await getBillingProvider().getSubscription({
      stripeSubscriptionId: payer.stripeSubscriptionId!,
    })
    expect(before?.status).toBe('active')

    const result = await applyPaymentHold(
      payer.id,
      { blockOnline: true, blockPartial: true, certifiedFundsOnly: false, reason: REASON },
      staffId,
      writeAudit,
    )
    expect(result.ok).toBe(true)

    // AFTER, WITH NO SWEEP HAVING RUN. This is the whole assertion: the
    // subscription is paused the moment the switch is flipped, not the next
    // morning when the nightly reconciliation would have caught up.
    const after = await getBillingProvider().getSubscription({
      stripeSubscriptionId: payer.stripeSubscriptionId!,
    })
    expect(after?.status).toBe('paused')

    const row = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
    expect(row.collectionPaused).toBe(true)
    expect(row.lastSyncAction).toBe('paused')
  }, 30_000)

  it('RESUMES STRIPE when the hold is lifted', async () => {
    // The other direction, and it could not be tested at all until the
    // simulator stopped reporting every subscription as active: `resume`
    // only fires when Stripe says paused and the lease says it should not
    // be, so a simulator that never said "paused" made this branch
    // unreachable — and lifting a hold silently left collection stopped.
    const { payer } = await seedProvisionedPayer()

    await applyPaymentHold(
      payer.id,
      { blockOnline: true, blockPartial: false, certifiedFundsOnly: false, reason: REASON },
      staffId,
      writeAudit,
    )
    expect(
      (await getBillingProvider().getSubscription({
        stripeSubscriptionId: payer.stripeSubscriptionId!,
      }))?.status,
    ).toBe('paused')

    await applyPaymentHold(
      payer.id,
      {
        blockOnline: false,
        blockPartial: false,
        certifiedFundsOnly: false,
        reason: 'Case dismissed; collection resumes.',
      },
      staffId,
      writeAudit,
    )

    expect(
      (await getBillingProvider().getSubscription({
        stripeSubscriptionId: payer.stripeSubscriptionId!,
      }))?.status,
    ).toBe('active')
  }, 30_000)

  it('REVOKES LIVE PAY-NOW LINKS, which no screen would have shown', async () => {
    // The leak that is easy to miss: a token minted before the notice is a
    // payment surface sitting in somebody's text messages, and nothing in
    // the product displays it.
    const { payer, lease, tenant } = await seedProvisionedPayer()
    const link = await issuePayLink({
      leasePayerId: payer.id,
      tenantId: tenant.id,
      leaseId: lease.id,
    })
    expect((await verifyPayLink(link.token)).ok).toBe(true)

    const result = await applyPaymentHold(
      payer.id,
      { blockOnline: true, blockPartial: false, certifiedFundsOnly: false, reason: REASON },
      staffId,
      writeAudit,
    )
    expect(result.ok && result.linksRevoked).toBe(1)

    const dead = await verifyPayLink(link.token)
    expect(dead.ok).toBe(false)
  }, 30_000)

  it('does NOT revoke links when only partial payments are blocked', async () => {
    // The tenant may still pay — in full — so killing their link would be
    // taking away the way they were told to do it.
    const { payer, lease, tenant } = await seedProvisionedPayer()
    const link = await issuePayLink({
      leasePayerId: payer.id,
      tenantId: tenant.id,
      leaseId: lease.id,
    })

    await applyPaymentHold(
      payer.id,
      { blockOnline: false, blockPartial: true, certifiedFundsOnly: false, reason: REASON },
      staffId,
      writeAudit,
    )

    expect((await verifyPayLink(link.token)).ok).toBe(true)
  }, 30_000)

  describe('the record it leaves', () => {
    it('DEMANDS A REASON, because an eviction is argued from it', async () => {
      const { payer } = await seedProvisionedPayer()
      const result = await applyPaymentHold(
        payer.id,
        { blockOnline: true, blockPartial: false, certifiedFundsOnly: false, reason: 'legal' },
        staffId,
        writeAudit,
      )
      expect(result.ok).toBe(false)

      // And nothing was applied.
      const row = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
      expect(row.collectionPaused).toBe(false)
    }, 30_000)

    it('demands one for LIFTING a hold too', async () => {
      // "Why did we start taking their money again" is as much a part of
      // the record as why we stopped.
      const { payer } = await seedProvisionedPayer()
      await applyPaymentHold(
        payer.id,
        { blockOnline: true, blockPartial: false, certifiedFundsOnly: false, reason: REASON },
        staffId,
        writeAudit,
      )
      const result = await applyPaymentHold(
        payer.id,
        { blockOnline: false, blockPartial: false, certifiedFundsOnly: false, reason: 'ok' },
        staffId,
        writeAudit,
      )
      expect(result.ok).toBe(false)
    }, 30_000)

    it('records who, when and why, and clears them when the hold lifts', async () => {
      const { payer } = await seedProvisionedPayer()
      await applyPaymentHold(
        payer.id,
        { blockOnline: true, blockPartial: false, certifiedFundsOnly: false, reason: REASON },
        staffId,
        writeAudit,
      )

      const held = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
      expect(held.paymentHoldReason).toBe(REASON)
      expect(held.paymentHoldSetByStaffId).toBe(staffId)
      expect(held.paymentHoldSetAt).not.toBeNull()

      await applyPaymentHold(
        payer.id,
        {
          blockOnline: false,
          blockPartial: false,
          certifiedFundsOnly: false,
          reason: 'Case dismissed; collection resumes.',
        },
        staffId,
        writeAudit,
      )
      const lifted = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
      // Cleared, so a lifted hold does not read as a live one — the audit
      // trail is where the history lives, not this row.
      expect(lifted.paymentHoldReason).toBeNull()
      expect(lifted.paymentHoldSetAt).toBeNull()
    }, 30_000)

    it('AUDITS THE CHANGE WITH A REASON, and records what Stripe actually did', async () => {
      const { payer } = await seedProvisionedPayer()
      await applyPaymentHold(
        payer.id,
        { blockOnline: true, blockPartial: true, certifiedFundsOnly: true, reason: REASON },
        staffId,
        writeAudit,
      )

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: payer.id, action: 'payment.hold_changed' },
        orderBy: { occurredAt: 'desc' },
      })
      expect(entry.reason).toBe(REASON)
      // "We believed this was held" and "Stripe was actually told" are
      // different facts, and a dispute needs both.
      expect(entry.after).toMatchObject({
        blockOnline: true,
        blockPartial: true,
        certifiedFundsOnly: true,
        stripeOutcome: 'paused',
      })
    }, 30_000)
  })
})
