import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// TCPA consent against a real database (COMM-02, R-051b).
//
// ==========================================================================
// THE ASSERTION THAT MATTERS MOST is the last group: a tenant with no consent
// on file does not get a text, and the delivery row says `no_consent` rather
// than `preference_off`. Everything above it is the machinery that makes that
// verdict defensible - the basis, the withdrawal, and the fact that neither
// can be quietly edited afterwards.
// ==========================================================================

let propertyId: string
let entityId: string
let consentedTenantId: string
let unconsentedTenantId: string
const deliveryIds: string[] = []
/// The engine takes addresses ON the recipient rather than looking them up,
/// so the fixture has to hand them over the way every real caller does.
const tenantsById = new Map<string, { id: string; email: string | null; phone: string | null }>()

beforeAll(async () => {
  const stamp = `consent-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '3 Consent Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id

  const makeTenant = async (label: string) => {
    return prisma.tenant.create({
      data: {
        firstName: label,
        lastName: `Consent-${randomUUID().slice(0, 6)}`,
        email: `${label.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
        // A distinct number per tenant: `isOptedOut` is keyed on the number,
        // and a shared literal would let one test's opt-out leak into another.
        phone: `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      },
    })
  }
  const consented = await makeTenant('Cora')
  const unconsented = await makeTenant('Ulf')
  consentedTenantId = consented.id
  unconsentedTenantId = unconsented.id
  tenantsById.set(consented.id, consented)
  tenantsById.set(unconsented.id, unconsented)

  await prisma.tenantConsent.create({
    data: {
      tenantId: consentedTenantId,
      channel: 'SMS',
      basis: 'EXISTING_RELATIONSHIP',
      source: 'BACKFILL',
      note: 'test fixture',
    },
  })
})

afterAll(async () => {
  // TenantConsent is append-only and RESTRICTs the tenant it points at, so
  // the tenants stay. Deactivated rather than deleted, the same pattern every
  // suite touching an append-only table has had to adopt.
  await prisma.tenant.updateMany({
    where: { id: { in: [consentedTenantId, unconsentedTenantId] } },
    data: { active: false },
  })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

describe('TenantConsent constraints', () => {
  it('REFUSES express written consent with no disclosure text', async () => {
    // The basis that unlocks marketing is the one that must be able to show
    // what was agreed to. Enforced by CHECK, not just by the action.
    await expect(
      prisma.tenantConsent.create({
        data: {
          tenantId: consentedTenantId,
          channel: 'SMS',
          basis: 'EXPRESS_WRITTEN',
          source: 'STAFF_RECORDED',
        },
      }),
    ).rejects.toThrow()
  })

  it('accepts it once the wording is there', async () => {
    const row = await prisma.tenantConsent.create({
      data: {
        tenantId: consentedTenantId,
        channel: 'EMAIL',
        basis: 'EXPRESS_WRITTEN',
        source: 'STAFF_RECORDED',
        disclosureText: 'I agree to receive messages at the number provided.',
      },
    })
    expect(row.disclosureText).toContain('I agree')
  })
})

describe('TenantConsent is append-only except for withdrawal', () => {
  async function consent() {
    return prisma.tenantConsent.create({
      data: {
        tenantId: consentedTenantId,
        channel: 'VOICE',
        basis: 'VERBAL',
        source: 'STAFF_RECORDED',
      },
    })
  }

  it('REFUSES a DELETE', async () => {
    const row = await consent()
    await expect(prisma.tenantConsent.delete({ where: { id: row.id } })).rejects.toThrow()
  })

  it('REFUSES an edit to the basis — the whole evidentiary content', async () => {
    const row = await consent()
    await expect(
      prisma.tenantConsent.update({
        where: { id: row.id },
        data: { basis: 'EXPRESS_WRITTEN' },
      }),
    ).rejects.toThrow()
  })

  it('allows withdrawal once, with a reason, and refuses a second', async () => {
    const row = await consent()
    const withdrawn = await prisma.tenantConsent.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), revokeReason: 'asked us to stop on a call' },
    })
    expect(withdrawn.revokedAt).not.toBeNull()

    await expect(
      prisma.tenantConsent.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      }),
    ).rejects.toThrow()
  })

  it('refuses to smuggle another change in alongside the withdrawal', async () => {
    const row = await consent()
    await expect(
      prisma.tenantConsent.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), basis: 'IMPORTED' },
      }),
    ).rejects.toThrow()
  })
})

describe('the send path refuses a text to a tenant who never agreed', () => {
  async function smsOutcome(tenantId: string, key: string) {
    const outcomes = await notify({
      category: 'rent_reminder',
      templateKey: 'payment.due_soon',
      recipient: {
        type: 'TENANT',
        id: tenantId,
        email: tenantsById.get(tenantId)?.email ?? null,
        phone: tenantsById.get(tenantId)?.phone ?? null,
      },
      context: {
        tenantName: 'Test Tenant',
        addressLine1: '3 Consent Court',
        amount: '$1,500.00',
        dueOn: '2026-09-01',
        isDueToday: false,
      },
      propertyId,
      idempotencyKey: key,
    })
    const sms = outcomes.find((outcome) => outcome.channel === 'SMS')
    // Read back by the id the engine returned. `NotificationDelivery` is 1:1
    // with a Notification and carries no createdAt, so "the newest row for
    // this tenant" is not a query this table supports.
    const delivery = sms?.deliveryId
      ? await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: sms.deliveryId } })
      : null
    return { sms, delivery, outcomes }
  }

  it('SUPPRESSES the SMS as no_consent, and says so on the delivery row', async () => {
    const { sms, delivery } = await smsOutcome(unconsentedTenantId, `consent-none-${randomUUID()}`)
    expect(sms?.status).toBe('SUPPRESSED')
    // NOT `preference_off`. A tenant who was never asked has expressed no
    // preference, and recording one would hide a gap behind a choice.
    expect(delivery?.suppressedReason).toBe('no_consent')
  })

  it('does NOT touch the other channels — consent is per channel', async () => {
    // The message still reaches them where it lawfully can. Gating every
    // channel on a texting permission would be a worse outcome than the risk
    // it removes.
    const { outcomes } = await smsOutcome(unconsentedTenantId, `consent-none2-${randomUUID()}`)
    const others = outcomes.filter((outcome) => outcome.channel !== 'SMS')
    expect(others.length).toBeGreaterThan(0)
    expect(others.every((outcome) => outcome.status !== 'SUPPRESSED')).toBe(true)
  })

  it('lets the SMS through for the tenant whose consent was backfilled', async () => {
    // The grandfathering decision: the existing roster keeps its rent
    // reminders rather than going silent on ship day.
    //
    // Asserted as "consent did not block it" rather than "QUEUED", because
    // quiet hours can legitimately DEFER the same message (D-3) and this
    // test is about consent, not about what hour it happens to run at.
    const { sms, delivery } = await smsOutcome(consentedTenantId, `consent-ok-${randomUUID()}`)
    // ASSERTED ON THE REASON, NOT ON THE STATUS. This tenant has no
    // notification preferences on file, and `rent_reminder` is not a locked
    // category - so the preference resolver suppresses it for reasons that
    // have nothing to do with consent and predate this item entirely.
    // Asserting QUEUED here would be asserting the preference default, and
    // would break the day somebody changes it. What this item must guarantee
    // is narrower and exact: consent is not what stopped the message.
    expect(
      delivery?.suppressedReason ?? null,
      'consent must not be what stopped this message',
    ).not.toBe('no_consent')
    if (sms?.deliveryId) deliveryIds.push(sms.deliveryId)
    await dispatchPendingNotifications(new Date(), 100, { deliveryIds })
  })

  it('stops sending once that consent is withdrawn', async () => {
    const live = await prisma.tenantConsent.findFirstOrThrow({
      where: { tenantId: consentedTenantId, channel: 'SMS', revokedAt: null },
    })
    await prisma.tenantConsent.update({
      where: { id: live.id },
      data: { revokedAt: new Date(), revokeReason: 'test withdrawal' },
    })

    const { sms, delivery } = await smsOutcome(consentedTenantId, `consent-gone-${randomUUID()}`)
    expect(sms?.status).toBe('SUPPRESSED')
    expect(delivery?.suppressedReason).toBe('no_consent')
  })
})
