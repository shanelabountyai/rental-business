import { randomUUID } from 'node:crypto'
import { SimulatedAccountingAdapter } from '@rental/core/accounting'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerSimulatedConsent, completeQuickBooksConnect, startQuickBooksConnect } from './quickbooks.ts'
import { docNumber, syncQuickBooks } from './quickbooks-sync.ts'

// R-282a (PRD 09 Q3-Q5, Q7; D-312, D-397). One accrual connection in its own
// org, against the simulated company file with fault injection. Ledger rows
// and sync links are append-only, so they and the connection they point at
// are left standing; the property is deactivated.

const stamp = `r282-${randomUUID().slice(0, 8)}`
const CALLBACK = 'https://x.example.test/money/quickbooks/callback'
const DAY = 24 * 60 * 60 * 1000
let orgId = ''
let entityId = ''
let propertyId = ''
let leaseId = ''
let leasePayerId = ''
let connectionId = ''
let lose = false
const qbo = new SimulatedAccountingAdapter({ fault: (op) => (op === 'post' && lose ? 'partial_failure' : null) })
const sync = () => syncQuickBooks(orgId, { adapterFor: () => qbo })

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { slug: stamp, name: `Org ${stamp}` } })).id
  entityId = (await prisma.legalEntity.create({ data: { orgId, name: `${stamp} LLC`, type: 'LLC' } })).id
  propertyId = (
    await prisma.property.create({
      data: {
        orgId,
        legalEntityId: entityId,
        name: `${stamp} house`,
        addressLine1: '1 Journal Way',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
  ).id
  const unit = await prisma.unit.create({ data: { propertyId, name: 'U1', status: 'OCCUPIED' } })
  const tenant = await prisma.tenant.create({ data: { orgId, firstName: 'Quinn', lastName: stamp } })
  leaseId = (
    await prisma.lease.create({
      data: { propertyId, unitId: unit.id, status: 'ACTIVE', startsOn: new Date('2026-01-01'), endsOn: new Date('2026-12-31'), rentCents: 150_000 },
    })
  ).id
  leasePayerId = (await prisma.leasePayer.create({ data: { leaseId, propertyId, payerType: 'TENANT', tenantId: tenant.id } })).id

  const started = await startQuickBooksConnect(orgId, { legalEntityId: entityId, basis: 'ACCRUAL' }, CALLBACK)
  if (!started.ok) throw new Error(started.error)
  const state = new URL(started.url).searchParams.get('state')!
  const back = new URL(await answerSimulatedConsent(state, { approve: true, realmId: `${stamp}-realm` }, CALLBACK))
  const q = (key: string) => back.searchParams.get(key)
  await completeQuickBooksConnect(orgId, { state: q('state'), code: q('code'), realmId: q('realmId'), error: q('error') }, CALLBACK)
  connectionId = (await prisma.quickBooksConnection.findUniqueOrThrow({ where: { legalEntityId: entityId } })).id
})

afterAll(async () => {
  await prisma.property.update({ where: { id: propertyId }, data: { active: false } })
  await prisma.simulatedQuickBooksGrant.deleteMany({ where: { realmId: { startsWith: stamp } } })
})

const entry = (type: 'CHARGE' | 'PAYMENT' | 'ADJUSTMENT', amountCents: number, occurredAt: Date, paymentId: string | null = null) =>
  prisma.ledgerEntry.create({
    data: { propertyId, leaseId, leasePayerId, type, amountCents, description: type, occurredAt, paymentId },
  })

const links = () => prisma.quickBooksSyncLink.findMany({ where: { connectionId }, include: { journal: true } })

describe('QuickBooks nightly sync (R-282a)', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * DAY)

  it('blocks the whole connection, naming what is unmapped, and plans nothing', async () => {
    await entry('CHARGE', 150_000, twoDaysAgo)
    const payment = await prisma.payment.create({
      data: { propertyId, leaseId, leasePayerId, channel: 'ACH', status: 'SETTLED', amountCents: 150_000, receivedAt: twoDaysAgo },
    })
    await entry('PAYMENT', -150_000, twoDaysAgo, payment.id)
    await entry('ADJUSTMENT', 3_000, twoDaysAgo)
    await entry('CHARGE', 150_000, new Date()) // today: its day has not ended

    const [result] = await sync()
    expect(result).toMatchObject({ outcome: 'blocked', reason: /ACCOUNTS_RECEIVABLE, RENTAL_INCOME, UNDEPOSITED_FUNDS.*house/ })
    expect(await links()).toHaveLength(0)
    expect((await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connectionId } })).syncProblem).toMatch(/not mapped/)
  })

  it('posts one balanced entry per day, exactly once across a lost response, and excludes with a reason', async () => {
    const map = (kind: 'ACCOUNT' | 'PROPERTY', platformKey: string) => ({
      orgId, connectionId, kind, platformKey, externalId: `qbo-${platformKey}`, externalName: platformKey,
    })
    await prisma.quickBooksMapping.createMany({
      data: [
        map('ACCOUNT', 'ACCOUNTS_RECEIVABLE'),
        map('ACCOUNT', 'RENTAL_INCOME'),
        map('ACCOUNT', 'UNDEPOSITED_FUNDS'),
        map('PROPERTY', propertyId),
      ],
    })

    lose = true
    const [first] = await sync()
    expect(first).toMatchObject({ outcome: 'blocked', reason: /did not answer.*retried next run/ })
    lose = false
    const [second] = await sync()
    expect(second).toMatchObject({ outcome: 'synced', planned: 0, posted: 1 })

    const rows = await links()
    const journal = rows.find((r) => r.journal)!.journal!
    expect(journal).toMatchObject({ status: 'POSTED', propertyId })
    expect(qbo.posted.filter((e) => e.docNumber === docNumber(journal.number))).toHaveLength(1)
    const posted = qbo.posted.find((e) => e.docNumber === docNumber(journal.number))!
    expect(posted.property).toEqual({ id: `qbo-${propertyId}`, name: propertyId, field: 'CLASS' })
    // Accrual: rent billed and paid the same day clears A/R and leaves income and cash.
    expect(posted.lines).toHaveLength(4)
    expect(rows.filter((r) => r.journalId)).toHaveLength(2)
    expect(rows.filter((r) => r.excludedReason)).toEqual([expect.objectContaining({ excludedReason: expect.stringMatching(/D-306/) })])
    // Today's charge is still waiting.
    expect(rows).toHaveLength(3)
  })

  it('puts a late-projected entry for an old day in a NEW journal, and re-runs post nothing', async () => {
    const before = qbo.posted.length
    expect((await sync())[0]).toMatchObject({ outcome: 'synced', planned: 0, posted: 0 })
    expect(qbo.posted).toHaveLength(before)

    await entry('CHARGE', 2_500, twoDaysAgo)
    expect((await sync())[0]).toMatchObject({ outcome: 'synced', planned: 1, posted: 1 })
    const journals = await prisma.quickBooksJournal.findMany({ where: { connectionId }, orderBy: { number: 'asc' } })
    expect(journals).toHaveLength(2)
    expect(journals[0]!.txnDate).toEqual(journals[1]!.txnDate)
    expect(new Set(qbo.posted.slice(before).map((e) => e.docNumber)).size).toBe(1)
  })

  it('refuses to delete a sync link, which would post the entry again', async () => {
    const [link] = await links()
    await expect(prisma.quickBooksSyncLink.delete({ where: { ledgerEntryId: link!.ledgerEntryId } })).rejects.toThrow()
  })
})
