import { randomUUID } from 'node:crypto'
import { US_STATE_OPTIONS } from '@rental/core/property'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableOrgState, recordCounselReview, setOrgPolicy } from '@/lib/jurisdiction/actions.ts'
import { counselUnreviewed, stateNotEnabled } from '@/lib/jurisdiction/org-states.ts'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'
import { createProperty } from '@/lib/properties/actions.ts'

// R-298a (PRD 10 §7.2, D-389): an owner enables a state and records counsel's
// review; a property outside the org's states is refused. Session mocked, the
// grant and the RBAC decision real - same seam as cross-property-ids.test.ts.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const session = vi.hoisted(() => ({ staffId: '' }))
vi.mock('@/auth.ts', () => ({
  auth: async () => ({ principal: { kind: 'staff', id: session.staffId, mfaVerified: true } }),
}))

const unique = randomUUID().slice(0, 8)
const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.set(k, v)
  return data
}
let ownerId = ''
let managerId = ''
let entityId = ''
// A real state org #0 has not enabled. Deleted in afterAll - OrgJurisdiction
// is not append-only - so runs do not use the alphabet up.
let state = ''

beforeAll(async () => {
  const enabled = new Set(
    (await prisma.orgJurisdiction.findMany({ where: { orgId: 'org_0' }, select: { state: true } })).map((r) => r.state),
  )
  state = US_STATE_OPTIONS.map((s) => s.code).find((code) => !enabled.has(code))!
  const [owner, manager] = await Promise.all(
    ['owner', 'manager'].map((key) => prisma.role.findUniqueOrThrow({ where: { key } })),
  )
  ownerId = (
    await prisma.staffUser.create({
      data: {
        email: `oj-owner-${unique}@example.test`,
        name: 'OJ Owner',
        orgMemberships: { create: { orgId: 'org_0' } },
        assignments: { create: { orgId: 'org_0', roleId: owner!.id } },
      },
    })
  ).id
  managerId = (
    await prisma.staffUser.create({
      data: {
        email: `oj-manager-${unique}@example.test`,
        name: 'OJ Manager',
        orgMemberships: { create: { orgId: 'org_0' } },
        assignments: { create: { orgId: 'org_0', roleId: manager!.id } },
      },
    })
  ).id
  entityId = (await prisma.legalEntity.create({ data: { orgId: 'org_0', name: `OJ Entity ${unique}`, type: 'LLC' } })).id
})

beforeEach(() => {
  session.staffId = ownerId
})

afterAll(async () => {
  await prisma.orgJurisdiction.deleteMany({ where: { orgId: 'org_0', state } })
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: [ownerId, managerId] } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: [ownerId, managerId] } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

describe('per-org states (R-298a)', () => {
  it('refuses a property in a state the org has not enabled', async () => {
    const result = await createProperty(
      {},
      form({
        legalEntityId: entityId,
        name: `OJ House ${unique}`,
        propertyType: 'SINGLE_FAMILY',
        timezone: 'America/Chicago',
        addressLine1: `${unique} Gate St`,
        city: 'Anytown',
        state,
        postalCode: '77002',
      }),
    )
    expect(result.fieldErrors?.state).toContain(`${state} is not enabled`)
  })

  it('is owner-only', async () => {
    session.staffId = managerId
    await expect(enableOrgState({}, form({ state }))).rejects.toThrow()
  })

  it('enables once, audits once, and leaves counsel review unrecorded', async () => {
    const unseeded = !(await rulesForConfigured({ orgId: null, state }, new Date()))
    const first = await enableOrgState({}, form({ state }))
    expect(first.notice).toContain(`${state} enabled`)
    expect(await enableOrgState({}, form({ state }))).toEqual({ notice: `${state} is already enabled.` })
    expect(await stateNotEnabled('org_0', state)).toBeNull()
    expect(await counselUnreviewed('org_0', state)).toBe(true)
    const audits = await prisma.auditLog.findMany({
      where: { orgId: 'org_0', action: 'org_jurisdiction.enabled', actorStaffId: ownerId },
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]!.after).toMatchObject({ state, unseeded })
  })

  it('records counsel review, refusing a future date and a state not enabled', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    expect((await recordCounselReview({}, form({ state, reviewedBy: 'Q. Counsel', reviewedOn: tomorrow }))).error).toMatch(/future/)
    expect((await recordCounselReview({}, form({ state: 'ZZ', reviewedBy: 'Q. Counsel', reviewedOn: '2026-01-02' }))).error).toMatch(
      /not enabled/,
    )
    expect((await recordCounselReview({}, form({ state, reviewedBy: 'Q. Counsel', reviewedOn: '2026-01-02' }))).notice).toContain(
      'Q. Counsel',
    )
    expect(await counselUnreviewed('org_0', state)).toBe(false)
  })
})

describe('the org policy (R-298b, D-390)', () => {
  it('saves, audits, refuses nonsense, and blank clears', async () => {
    await enableOrgState({}, form({ state }))
    const fields = { state, graceDays: '5', lateFeeMaxDollars: '25', entryNoticeHours: '' }
    expect((await setOrgPolicy({}, form({ ...fields, graceDays: '2.5' }))).error).toMatch(/Grace days/)
    expect((await setOrgPolicy({}, form({ ...fields, entryNoticeHours: '999' }))).error).toMatch(/Entry notice/)
    expect((await setOrgPolicy({}, form({ ...fields, state: 'ZZ' }))).error).toMatch(/not enabled/)
    expect((await setOrgPolicy({}, form(fields))).notice).toContain(`${state} policy`)
    expect(await prisma.orgJurisdiction.findUniqueOrThrow({ where: { orgId_state: { orgId: 'org_0', state } } })).toMatchObject({
      policyGraceDays: 5,
      policyLateFeeMaxCents: 2500,
      policyEntryNoticeHours: null,
    })
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { orgId: 'org_0', action: 'org_jurisdiction.policy_set', actorStaffId: ownerId },
    })
    expect(audit.after).toMatchObject({ state, policyGraceDays: 5, policyLateFeeMaxCents: 2500 })

    session.staffId = managerId
    await expect(setOrgPolicy({}, form(fields))).rejects.toThrow()
  })
})
