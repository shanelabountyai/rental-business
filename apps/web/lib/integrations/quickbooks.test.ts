import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  OAUTH_STATE_TTL_MS,
  answerSimulatedConsent,
  completeQuickBooksConnect,
  disconnectQuickBooks,
  quickBooksAccessToken,
  revokeSimulatedGrants,
  startQuickBooksConnect,
} from './quickbooks.ts'

// R-280 (PRD 09 Q1, D-393 to D-396). Runs against the simulated authorizer,
// whose grants live in its own table (D-27) and whose refresh tokens rotate
// on every use. No action is called, so the only AuditLog row is the SYSTEM
// reconnect one, which pins org A: the orgs are left standing.

const stamp = `r280-${randomUUID().slice(0, 8)}`
const CALLBACK = 'https://x.example.test/money/quickbooks/callback'
const realm = (name: string) => `${stamp}-${name}`
let orgA = ''
let orgB = ''
let entityA = ''
let entityA2 = ''
let entityB = ''
let propertyId = ''

beforeAll(async () => {
  orgA = (await prisma.organization.create({ data: { slug: `${stamp}-a`, name: `Org ${stamp} A` } })).id
  orgB = (await prisma.organization.create({ data: { slug: `${stamp}-b`, name: `Org ${stamp} B` } })).id
  entityA = (await prisma.legalEntity.create({ data: { orgId: orgA, name: `${stamp} One LLC`, type: 'LLC' } })).id
  entityA2 = (await prisma.legalEntity.create({ data: { orgId: orgA, name: `${stamp} Two LLC`, type: 'LLC' } })).id
  entityB = (await prisma.legalEntity.create({ data: { orgId: orgB, name: `${stamp} B LLC`, type: 'LLC' } })).id
  propertyId = (
    await prisma.property.create({
      data: {
        orgId: orgA,
        legalEntityId: entityA,
        name: stamp,
        addressLine1: '1 Ledger Way',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
  ).id
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { propertyId } })
  await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  await prisma.quickBooksConnection.deleteMany({ where: { legalEntityId: { in: [entityA, entityA2, entityB] } } })
  await prisma.simulatedQuickBooksGrant.deleteMany({ where: { realmId: { startsWith: stamp } } })
})

/// Start, consent and call back, as the browser would.
async function connect(orgId: string, legalEntityId: string, realmId: string, opts: { basis?: 'CASH' | 'ACCRUAL'; approve?: boolean } = {}) {
  const started = await startQuickBooksConnect(orgId, { legalEntityId, basis: opts.basis }, CALLBACK)
  if (!started.ok) return started
  const state = new URL(started.url).searchParams.get('state')!
  const back = new URL(await answerSimulatedConsent(state, { approve: opts.approve ?? true, realmId }, CALLBACK))
  const query = (key: string) => back.searchParams.get(key)
  const callback = { state: query('state'), code: query('code'), realmId: query('realmId'), error: query('error') }
  return { ...(await completeQuickBooksConnect(orgId, callback, CALLBACK)), callback }
}

const row = (legalEntityId: string) => prisma.quickBooksConnection.findUniqueOrThrow({ where: { legalEntityId } })
const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60 * 1000)

describe('QuickBooks connection, simulated (R-280)', () => {
  it('requires a basis on a first connect (D-393) and an entity of the actor’s own org', async () => {
    expect(await startQuickBooksConnect(orgA, { legalEntityId: entityA }, CALLBACK)).toMatchObject({ ok: false, error: /cash or accrual/ })
    expect(await startQuickBooksConnect(orgA, { legalEntityId: entityB, basis: 'CASH' }, CALLBACK)).toMatchObject({ ok: false })
    expect(await prisma.quickBooksConnection.count({ where: { legalEntityId: { in: [entityA, entityB] } } })).toBe(0)
  })

  it('connects, seals the tokens and serves the access token without refreshing while it is fresh', async () => {
    const done = await connect(orgA, entityA, realm('one'), { basis: 'ACCRUAL' })
    expect(done).toMatchObject({ ok: true, legalEntityId: entityA })
    const connected = await row(entityA)
    expect(connected).toMatchObject({ status: 'CONNECTED', realmId: realm('one'), basis: 'ACCRUAL', propertyField: 'CLASS', oauthStateHash: null })
    const grant = await prisma.simulatedQuickBooksGrant.findFirstOrThrow({ where: { realmId: realm('one') } })
    expect(connected.secret).not.toContain(grant.refreshToken)

    expect(await quickBooksAccessToken(entityA)).toEqual({ ok: true, accessToken: grant.accessToken, realmId: realm('one') })
    expect((await row(entityA)).secret).toBe(connected.secret)
  })

  it('spends the state: a replayed callback and another org’s callback both find nothing', async () => {
    const started = await startQuickBooksConnect(orgA, { legalEntityId: entityA2, basis: 'CASH' }, CALLBACK)
    if (!started.ok) throw new Error(started.error)
    const state = new URL(started.url).searchParams.get('state')!
    const back = new URL(await answerSimulatedConsent(state, { approve: true, realmId: realm('two') }, CALLBACK))
    const callback = { state, code: back.searchParams.get('code'), realmId: realm('two'), error: null }

    expect(await completeQuickBooksConnect(orgB, callback, CALLBACK)).toEqual({ ok: false, error: expect.stringMatching(/not valid here/) })
    expect(await completeQuickBooksConnect(orgA, callback, CALLBACK)).toMatchObject({ ok: true })
    expect(await completeQuickBooksConnect(orgA, callback, CALLBACK)).toMatchObject({ ok: false, error: /not valid here/ })
    await disconnectQuickBooks(orgA, entityA2)
  })

  it('refuses a company file already connected to another entity (D-394)', async () => {
    const done = await connect(orgA, entityA2, realm('one'))
    expect(done).toMatchObject({ ok: false, error: /already connected to another entity/ })
    expect(await row(entityA2)).toMatchObject({ status: 'DISCONNECTED', realmId: null, secret: null })
  })

  it('refuses an expired state and records a cancel as the reason', async () => {
    const started = await startQuickBooksConnect(orgA, { legalEntityId: entityA2 }, CALLBACK)
    if (!started.ok) throw new Error(started.error)
    const state = new URL(started.url).searchParams.get('state')!
    const late = new Date(Date.now() + OAUTH_STATE_TTL_MS + 60_000)
    expect(await completeQuickBooksConnect(orgA, { state, code: 'x', realmId: 'x', error: null }, CALLBACK, late)).toMatchObject({
      ok: false,
      error: /too long/,
    })

    expect(await connect(orgA, entityA2, realm('two'), { approve: false })).toMatchObject({ ok: false, error: /cancelled/ })
    expect((await row(entityA2)).statusReason).toMatch(/cancelled/)
  })

  it('refreshes before expiry, rotating the refresh token, and two callers racing both get a token', async () => {
    // The live grant: the "another entity" test above left a revoked one for this realm too.
    const live = { realmId: realm('one'), revokedAt: null }
    const before = await prisma.simulatedQuickBooksGrant.findFirstOrThrow({ where: live })
    const [first, second] = await Promise.all([quickBooksAccessToken(entityA, inTwoHours()), quickBooksAccessToken(entityA, inTwoHours())])
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    const after = await prisma.simulatedQuickBooksGrant.findFirstOrThrow({ where: live })
    expect(after.refreshToken).not.toBe(before.refreshToken)
    expect(await row(entityA)).toMatchObject({ status: 'CONNECTED' })
  })

  it('turns RECONNECT_NEEDED when QuickBooks refuses the refresh, and tells the owner once', async () => {
    await revokeSimulatedGrants(realm('one'))
    expect(await quickBooksAccessToken(entityA, inTwoHours())).toMatchObject({ ok: false, reason: /revoked/ })
    expect(await row(entityA)).toMatchObject({ status: 'RECONNECT_NEEDED', secret: null, realmId: realm('one') })
    expect(await quickBooksAccessToken(entityA, inTwoHours())).toMatchObject({ ok: false, reason: /not connected/ })

    const tasks = await prisma.task.findMany({ where: { propertyId, type: 'quickbooks_reconnect' } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ subjectType: 'QuickBooksConnection', priority: 'URGENT' })
    expect(await prisma.auditLog.count({ where: { orgId: orgA, action: 'integration.reconnect_needed' } })).toBe(1)
  })

  it('reconnects only to the same company file, keeping the basis', async () => {
    expect(await connect(orgA, entityA, realm('elsewhere'))).toMatchObject({ ok: false, error: /different QuickBooks company/ })
    expect(await row(entityA)).toMatchObject({ status: 'RECONNECT_NEEDED' })

    expect(await connect(orgA, entityA, realm('one'), { basis: 'CASH' })).toMatchObject({ ok: true })
    expect(await row(entityA)).toMatchObject({ status: 'CONNECTED', basis: 'ACCRUAL', statusReason: null })
  })

  it('disconnects: revoked at the simulator, tokens and realm forgotten here', async () => {
    expect(await disconnectQuickBooks(orgB, entityA)).toMatchObject({ ok: false })
    expect(await disconnectQuickBooks(orgA, entityA)).toMatchObject({ ok: true })
    expect(await row(entityA)).toMatchObject({ status: 'DISCONNECTED', secret: null, realmId: null })
    expect(await prisma.simulatedQuickBooksGrant.count({ where: { realmId: realm('one'), revokedAt: null } })).toBe(0)
  })
})
