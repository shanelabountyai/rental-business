import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueVerifyLink } from './verify-link.ts'
import {
  PAY_LINK_TTL_MINUTES,
  issuePayLink,
  payLinkRejection,
  revokePayLinks,
  verifyPayLink,
} from './pay-link.ts'

// Pay from the reminder, without a login (PAY-01, R-046).
//
// This token is the only thing between a URL in a text message and a screen
// that MOVES MONEY, so these tests are overwhelmingly about what it refuses.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let otherTenantId: string
let workOrderId: string

beforeAll(async () => {
  const stamp = `paylink-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '8 Pay Link Lane',
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
    // NO EMAIL — the persona this exists for: a phone and nothing else, who
    // cannot get through an email-only portal login at all.
    data: { firstName: 'Dana', lastName: `Pay-${randomUUID().slice(0, 6)}`, email: null },
  })
  tenantId = tenant.id
  const other = await prisma.tenant.create({
    data: { firstName: 'Someone', lastName: `Else-${randomUUID().slice(0, 6)}` },
  })
  otherTenantId = other.id

  // A work order, only so a TENANT_VERIFY token exists to replay below.
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId,
      source: 'PORTAL',
      category: 'PLUMBING',
      description: 'Tap drips.',
      priority: 'ROUTINE',
      status: 'CONVERTED',
    },
  })
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId: ticket.id,
      scope: 'Replace cartridge',
      status: 'WORK_COMPLETE',
      completedAt: new Date(),
    },
  })
  workOrderId = workOrder.id
})

afterAll(async () => {
  await prisma.tenant.updateMany({
    where: { id: { in: [tenantId, otherTenantId] } },
    data: { active: false },
  })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/// A payer to pay against. `active` and unpaused unless a test says otherwise.
async function seedPayer(
  overrides: { tenant?: string; collectionPaused?: boolean; active?: boolean } = {},
) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  const who = overrides.tenant ?? tenantId
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: who } })
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId: who,
      active: overrides.active ?? true,
      collectionPaused: overrides.collectionPaused ?? false,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  return { lease, payer }
}

async function issueFor(payerId: string, leaseId: string, notificationKey?: string) {
  return issuePayLink({
    leasePayerId: payerId,
    tenantId,
    leaseId,
    notificationKey: notificationKey ?? null,
  })
}

describe('issuePayLink / verifyPayLink', () => {
  it('authorizes the payer it was minted for', async () => {
    const { lease, payer } = await seedPayer()
    const { token } = await issueFor(payer.id, lease.id)

    const result = await verifyPayLink(token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.leasePayerId).toBe(payer.id)
    expect(result.leaseId).toBe(lease.id)
    expect(result.tenantId).toBe(tenantId)
    expect(result.tenantFirstName).toBe('Dana')
  }, 20_000)

  it('NEVER STORES THE RAW TOKEN — a dump of AuthToken yields nothing clickable', async () => {
    const { lease, payer } = await seedPayer()
    const { token } = await issueFor(payer.id, lease.id)

    const rows = await prisma.authToken.findMany({
      where: { purpose: 'TENANT_PAY_LINK', subjectId: payer.id },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).not.toBe(token)
    expect(JSON.stringify(rows[0])).not.toContain(token)
  }, 20_000)

  it('REFUSES A VERIFY TOKEN, though every purpose shares one table', async () => {
    // The purpose check is the whole reason this matters: without comparing
    // purpose, a maintenance link's raw token would open a payment screen.
    const verify = await issueVerifyLink({ workOrderId, tenantId, round: 1 })
    const result = await verifyPayLink(verify.token)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid')
  }, 20_000)

  it('refuses a forged token', async () => {
    const result = await verifyPayLink('not-a-real-token')
    expect(result.ok).toBe(false)
  }, 20_000)

  it('refuses an expired token, and says so distinctly from revoked', async () => {
    const { lease, payer } = await seedPayer()
    const { token } = await issueFor(payer.id, lease.id)

    const past = new Date(Date.now() + (PAY_LINK_TTL_MINUTES + 1) * 60_000)
    const result = await verifyPayLink(token, past)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('expired')
  }, 20_000)

  describe('revocation', () => {
    it('REISSUING KILLS THE PREVIOUS LINK', async () => {
      // A tenant who got a due-soon reminder and then a due-today reminder
      // holds ONE live link, not two.
      const { lease, payer } = await seedPayer()
      const first = await issueFor(payer.id, lease.id)
      const second = await issueFor(payer.id, lease.id)

      const stale = await verifyPayLink(first.token)
      expect(stale.ok).toBe(false)
      if (!stale.ok) expect(stale.reason).toBe('revoked')

      expect((await verifyPayLink(second.token)).ok).toBe(true)
    }, 20_000)

    it('revokePayLinks kills a live link outright, and reports how many', async () => {
      // What a legal-action hold (R-047) and a reported-forwarded-message
      // both need.
      const { lease, payer } = await seedPayer()
      const { token } = await issueFor(payer.id, lease.id)

      expect(await revokePayLinks(payer.id)).toBe(1)
      const result = await verifyPayLink(token)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('revoked')
    }, 20_000)

    it('DISTINGUISHES revoked from expired, because they tell a tenant different things', async () => {
      // Both are `consumedAt` to `checkToken`. One says "ask for a new one",
      // the other says "call us" — and a tenant told the wrong one either
      // waits for a link that will not come, or calls when they need not.
      expect(payLinkRejection('expired')).toMatch(/expired/i)
      expect(payLinkRejection('revoked')).toMatch(/no longer active/i)
      expect(payLinkRejection('expired')).not.toBe(payLinkRejection('revoked'))
    })
  })

  describe('what it refuses about the tenancy itself', () => {
    it('REFUSES A PAUSED TENANCY — PAY-12’s legal-action hold', async () => {
      const { lease, payer } = await seedPayer()
      const { token } = await issueFor(payer.id, lease.id)
      await prisma.leasePayer.update({
        where: { id: payer.id },
        data: { collectionPaused: true },
      })

      const result = await verifyPayLink(token)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('paused')
      // And says nothing about why — R-047 owns that message.
      expect(payLinkRejection('paused')).not.toMatch(/legal|eviction|court/i)
    }, 20_000)

    it('refuses once the payer is deactivated', async () => {
      const { lease, payer } = await seedPayer()
      const { token } = await issueFor(payer.id, lease.id)
      await prisma.leasePayer.update({ where: { id: payer.id }, data: { active: false } })

      expect((await verifyPayLink(token)).ok).toBe(false)
    }, 20_000)

    it('refuses once the tenant is deactivated', async () => {
      const gone = await prisma.tenant.create({
        data: { firstName: 'Gone', lastName: `Away-${randomUUID().slice(0, 6)}` },
      })
      const lease = await prisma.lease.create({
        data: {
          propertyId,
          unitId,
          status: 'ACTIVE',
          startsOn: new Date('2026-01-01'),
          rentCents: 150_000,
        },
      })
      await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: gone.id } })
      const payer = await prisma.leasePayer.create({
        data: {
          leaseId: lease.id,
          propertyId,
          payerType: 'TENANT',
          tenantId: gone.id,
          stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
        },
      })
      const { token } = await issuePayLink({
        leasePayerId: payer.id,
        tenantId: gone.id,
        leaseId: lease.id,
      })
      await prisma.tenant.update({ where: { id: gone.id }, data: { active: false } })

      expect((await verifyPayLink(token)).ok).toBe(false)
    }, 20_000)

    it('REFUSES WHEN THE PAYER’S TENANT HAS CHANGED SINCE ISSUE', async () => {
      // Belt and braces against a payer row edited between issue and use: a
      // link must never silently start paying for somebody else's tenancy.
      const { lease, payer } = await seedPayer()
      const { token } = await issueFor(payer.id, lease.id)
      await prisma.leasePayer.update({
        where: { id: payer.id },
        data: { tenantId: otherTenantId },
      })

      const result = await verifyPayLink(token)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid')
    }, 20_000)
  })

  describe('attribution back to the send record (PAY-01)', () => {
    it('carries the LOGICAL send key, which spans every channel it went out on', async () => {
      // Not a row id: `notify()` writes one Notification PER CHANNEL, so no
      // single row is "the" send. The engine suffixes the channel onto this
      // key, so the base finds them all.
      const { lease, payer } = await seedPayer()
      const notificationKey = `rent-due:today:${payer.id}:2026-08-01`
      const { token } = await issueFor(payer.id, lease.id, notificationKey)

      const result = await verifyPayLink(token)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.notificationKey).toBe(notificationKey)
    }, 20_000)

    it('is null for a link nobody sent in a message', async () => {
      // Reissued by hand from the office, say. Null is honest; a fabricated
      // id would make "did the reminder work" answer yes for a link no
      // reminder carried.
      const { lease, payer } = await seedPayer()
      const { token } = await issueFor(payer.id, lease.id)

      const result = await verifyPayLink(token)
      if (result.ok) expect(result.notificationKey).toBeNull()
    }, 20_000)
  })

  it('is SHORTER-LIVED than the verify link, because it can move money', () => {
    // The verify link's blast radius is a wrong answer to a maintenance
    // question. This one shows a balance and takes a payment.
    expect(PAY_LINK_TTL_MINUTES).toBeLessThan(60 * 24 * 7)
    expect(PAY_LINK_TTL_MINUTES).toBe(60 * 24 * 3)
  })
})
