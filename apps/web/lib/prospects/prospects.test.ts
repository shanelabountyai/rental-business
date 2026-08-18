import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { sendPrescreenInvite } from './actions.ts'
import { prescreenLinkStatus } from './prescreen-link.ts'
import { submitPrescreenAnswers } from './prescreen-actions.ts'
import { prospectForWrite, prospectsForScope } from './queries.ts'

// The database half of LEASE-07 (R-058) - everything EXCEPT submitInquiry
// (calls next/headers's headers(), which throws outside a real request
// scope under Vitest) and advanceProspectStage (session-dependent,
// requirePermission). Both are covered by e2e instead - see
// e2e/prospects.spec.ts and apps/web/lib/notices/notices.test.ts's own
// header for the identical split applied to a different item.

// revalidatePath needs a real Next.js request scope - same reason
// verify-link.test.ts's own mock exists for the identical call in
// answerFromLink.
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

function scopeOf(propertyIds: string[]): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: false,
  }
}

let entityId: string
let propertyId: string
let unitId: string
let listingId: string
const prospectIds: string[] = []

beforeAll(async () => {
  const stamp = `prospect-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '40 Pipeline Place',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  unitId = unit.id
  const listing = await prisma.listing.create({
    data: {
      propertyId,
      unitId,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingId = listing.id
})

afterAll(async () => {
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listing.deleteMany({ where: { id: listingId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedProspect(overrides: { email?: string | null; phone?: string | null } = {}) {
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: 'Priya',
      lastName: `Patel-${randomUUID().slice(0, 6)}`,
      email: overrides.email ?? `priya-${randomUUID().slice(0, 8)}@example.test`,
      phone: overrides.phone ?? null,
      source: 'ZILLOW',
    },
  })
  prospectIds.push(prospect.id)
  return prospect
}

async function tokenFor(prospectId: string): Promise<string> {
  await sendPrescreenInvite(prospectId)
  // sendPrescreenInvite mints the token but does not hand it back (it goes
  // straight into the notify() call) - the test reads it back the only way
  // it can: the delivery's own body, same as an actual email would carry it.
  const notification = await prisma.notification.findFirstOrThrow({
    where: { recipientType: 'PROSPECT', recipientId: prospectId },
    orderBy: { createdAt: 'desc' },
  })
  const match = /\/prescreen\/([^\s]+)/.exec(notification.body)
  if (!match) throw new Error('no prescreen link found in the rendered notification body')
  return match[1]!
}

describe('sendPrescreenInvite', () => {
  it('sends the identical invite and stamps preScreenSentAt', async () => {
    const prospect = await seedProspect()
    await sendPrescreenInvite(prospect.id)

    const after = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
    expect(after.preScreenSentAt).not.toBeNull()

    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'PROSPECT', recipientId: prospect.id },
    })
    expect(notification.category).toBe('prospect_prescreening')
    expect(notification.templateKey).toBe('prospect.prescreen_invite')
  })
})

describe('prescreenLinkStatus and submitPrescreenAnswers', () => {
  it('answers the identical five questions and moves the prospect to PRE_SCREENED', async () => {
    const prospect = await seedProspect()
    const token = await tokenFor(prospect.id)

    const before = await prescreenLinkStatus(token)
    expect(before.ok).toBe(true)

    const formData = new FormData()
    formData.set('moveDate', '2026-10-01')
    formData.set('occupants', '2')
    formData.set('incomeRange', 'RANGE_3000_5000')
    formData.set('priorEvictions', 'no')

    const result = await submitPrescreenAnswers(token, {}, formData)
    expect(result.error).toBeUndefined()

    const after = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
    expect(after.status).toBe('PRE_SCREENED')
    expect(after.preScreenRespondedAt).not.toBeNull()
    expect(after.incomeRange).toBe('RANGE_3000_5000')
    expect(after.occupants).toBe(2)

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'prospect.prescreened', entityId: prospect.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
  })

  it('refuses a second submission with the same link - the token is single-use', async () => {
    const prospect = await seedProspect()
    const token = await tokenFor(prospect.id)

    const formData = new FormData()
    formData.set('moveDate', '2026-10-01')
    formData.set('occupants', '1')
    formData.set('incomeRange', 'UNDER_3000')
    formData.set('priorEvictions', 'no')
    await submitPrescreenAnswers(token, {}, formData)

    const second = await submitPrescreenAnswers(token, {}, formData)
    expect(second.error).toBeTruthy()

    // The TOKEN's own consumedAt catches a same-token replay before the
    // Prospect row is even read - 'already_used', not 'already_answered'.
    // The latter is for a genuinely different, still-live token minted by a
    // resend after the prospect already answered once - see the next test.
    const status = await prescreenLinkStatus(token)
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.reason).toBe('already_used')
  })

  it('refuses via the PROSPECT fact even when a token itself would still pass', async () => {
    // sendPrescreenInvite's idempotencyKey means the application never
    // actually mints a second live token once one exists - this proves the
    // defensive check still holds if that ever changes, or if anything else
    // ever mints a second PROSPECT_PRESCREEN token for an already-answered
    // prospect. Built directly rather than through sendPrescreenInvite,
    // since there is no real path that reaches this today.
    const { issueToken } = await import('@/lib/auth/store.ts')
    const prospect = await seedProspect()
    const firstToken = await tokenFor(prospect.id)

    const formData = new FormData()
    formData.set('moveDate', '2026-10-01')
    formData.set('occupants', '1')
    formData.set('incomeRange', 'UNDER_3000')
    formData.set('priorEvictions', 'no')
    await submitPrescreenAnswers(firstToken, {}, formData)

    const extra = await issueToken('PROSPECT_PRESCREEN', { type: 'Prospect', id: prospect.id })
    const status = await prescreenLinkStatus(extra.token)
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.reason).toBe('already_answered')
  })

  it('does NOT write anything when validation fails, and the link stays usable', async () => {
    const prospect = await seedProspect()
    const token = await tokenFor(prospect.id)

    const formData = new FormData()
    // No moveDate, no occupants, no incomeRange, no priorEvictions.
    const result = await submitPrescreenAnswers(token, {}, formData)
    expect(result.error).toBeTruthy()

    const after = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
    expect(after.status).toBe('INQUIRY')
    expect(after.preScreenRespondedAt).toBeNull()

    // Still usable - a rejected form must not have burned the one link.
    const status = await prescreenLinkStatus(token)
    expect(status.ok).toBe(true)
  })

  it('rejects a forged token', async () => {
    const status = await prescreenLinkStatus('not-a-real-token')
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.reason).toBe('not_found')
  })
})

describe('prospectsForScope and prospectForWrite', () => {
  it('lists prospects within scope, newest first', async () => {
    const a = await seedProspect()
    // A short delay so createdAt orders deterministically - see
    // listings.test.ts's identical comment on the identical race.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await seedProspect()
    const list = await prospectsForScope(scopeOf([propertyId]))
    const ids = list.map((p) => p.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id))
  })

  it('returns null for a prospect outside scope', async () => {
    const prospect = await seedProspect()
    expect(await prospectForWrite(prospect.id, scopeOf(['some-other-property']))).toBeNull()
  })
})
