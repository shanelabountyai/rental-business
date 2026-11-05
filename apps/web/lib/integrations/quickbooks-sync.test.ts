import { randomUUID } from 'node:crypto'
import { SimulatedAccountingAdapter } from '@rental/core/accounting'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerSimulatedConsent, completeQuickBooksConnect, startQuickBooksConnect } from './quickbooks.ts'
import { reconcileQuickBooks } from './quickbooks-reconcile.ts'
import { docNumber, replayQuickBooksDate, syncQuickBooks } from './quickbooks-sync.ts'

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
let down = false
const qbo = new SimulatedAccountingAdapter({
  fault: (op) => (op === 'post' && lose ? 'partial_failure' : op === 'post' && down ? 'timeout' : null),
})
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

  it('posts the fee once in the entry of its payment, blocked until Merchant Fees is mapped (R-282b)', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * DAY)
    const payment = await prisma.payment.create({
      data: { propertyId, leaseId, leasePayerId, channel: 'CARD', status: 'SETTLED', amountCents: 100_000, receivedAt: threeDaysAgo },
    })
    // Allocated over two debts: two entries, one fee.
    await entry('PAYMENT', -60_000, threeDaysAgo, payment.id)
    await entry('PAYMENT', -40_000, threeDaysAgo, payment.id)
    const fee = await prisma.stripeProcessingFee.create({
      data: { orgId, paymentId: payment.id, amountCents: 2_930, stripeBalanceTransactionId: `txn_${stamp}`, details: [], stripeEventId: `evt_${stamp}` },
    })

    expect((await sync())[0]).toMatchObject({ outcome: 'blocked', reason: /accounts MERCHANT_FEES\)/ })
    await prisma.quickBooksMapping.create({
      data: { orgId, connectionId, kind: 'ACCOUNT', platformKey: 'MERCHANT_FEES', externalId: 'qbo-MERCHANT_FEES', externalName: 'Merchant Fees' },
    })
    const before = qbo.posted.length
    expect((await sync())[0]).toMatchObject({ outcome: 'synced', planned: 1, posted: 1 })
    const [posted] = qbo.posted.slice(before)
    expect(posted!.lines).toEqual([
      expect.objectContaining({ side: 'CREDIT', account: 'ACCOUNTS_RECEIVABLE', amountCents: 100_000 }),
      expect.objectContaining({ side: 'CREDIT', account: 'UNDEPOSITED_FUNDS', amountCents: 2_930 }),
      expect.objectContaining({ side: 'DEBIT', account: 'MERCHANT_FEES', amountCents: 2_930 }),
      expect.objectContaining({ side: 'DEBIT', account: 'UNDEPOSITED_FUNDS', amountCents: 100_000 }),
    ])
    await expect(prisma.stripeProcessingFee.delete({ where: { id: fee.id } })).rejects.toThrow()
  })

  it('refuses to delete a sync link, which would post the entry again', async () => {
    const [link] = await links()
    await expect(prisma.quickBooksSyncLink.delete({ where: { ledgerEntryId: link!.ledgerEntryId } })).rejects.toThrow()
  })
})

// R-283 (PRD 09 Q9, Q10), on the same fixture after R-282's tests have
// mapped it. March 2026 is a month nothing above writes into.
describe('QuickBooks reconciliation, sync now and replay (R-283)', () => {
  const MONTH = '2026-03'
  const reconcile = async () => {
    const result = await reconcileQuickBooks(orgId, entityId, MONTH, { adapterFor: () => qbo })
    if (!result.ok) throw new Error(result.error)
    return result
  }
  const row = (rows: { name: string; platformCents: number; quickBooksCents: number | null }[], name: string) =>
    rows.find((r) => r.name === name)

  it('totals per mapped account on both sides, and lists what is not in QuickBooks yet and why', async () => {
    const at = new Date('2026-03-10T18:00:00Z')
    await entry('CHARGE', 120_000, at)
    const paid = await prisma.payment.create({
      data: { propertyId, leaseId, leasePayerId, channel: 'CARD', status: 'SETTLED', amountCents: 120_000, receivedAt: at },
    })
    await entry('PAYMENT', -120_000, at, paid.id)
    await prisma.stripeProcessingFee.create({
      data: { orgId, paymentId: paid.id, amountCents: 3_510, stripeBalanceTransactionId: `txn_${stamp}_m`, details: [], stripeEventId: `evt_${stamp}_m` },
    })
    // Settled by Stripe, fee never read: it posts gross.
    const feeless = await prisma.payment.create({
      data: { propertyId, leaseId, leasePayerId, channel: 'ACH', status: 'SETTLED', amountCents: 5_000, receivedAt: at },
    })
    await entry('PAYMENT', -5_000, at, feeless.id)
    await entry('ADJUSTMENT', 700, at)

    // Before the sync: the platform has it, QuickBooks does not.
    const before = await reconcile()
    expect(row(before.accounts, 'Merchant Fees')).toEqual(expect.objectContaining({ platformCents: 3_510, quickBooksCents: 0 }))
    expect(before.problems.filter((p) => p.kind === 'not_synced')).toHaveLength(3)
    expect(before.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['excluded', 'missing_fee']))

    expect((await sync())[0]).toMatchObject({ outcome: 'synced' })
    const after = await reconcile()
    expect(after.quickBooksError).toBeNull()
    for (const account of after.accounts) expect(account.quickBooksCents).toBe(account.platformCents)
    // Accrual: A/R is the charge less both payments; cash is both payments less the fee.
    expect(row(after.accounts, 'ACCOUNTS_RECEIVABLE')!.platformCents).toBe(120_000 - 120_000 - 5_000)
    expect(row(after.accounts, 'UNDEPOSITED_FUNDS')!.platformCents).toBe(125_000 - 3_510)
    expect(after.problems.map((p) => p.kind).sort()).toEqual(['excluded', 'missing_fee'])
  })

  it('shows a failed journal and the variance it leaves, and replay posts a day a bookkeeper deleted exactly once', async () => {
    down = true
    await entry('CHARGE', 9_900, new Date('2026-03-11T18:00:00Z'))
    expect((await sync())[0]).toMatchObject({ outcome: 'blocked', reason: /timeout/ })
    down = false
    const failed = await reconcile()
    expect(failed.problems).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'failed', day: '2026-03-11' })]))
    expect(row(failed.accounts, 'RENTAL_INCOME')).toEqual(expect.objectContaining({ platformCents: -129_900, quickBooksCents: -120_000 }))

    // The 11th goes through on replay; the 10th is deleted in QuickBooks, then replayed.
    expect(await replayQuickBooksDate(orgId, entityId, '2026-03-11', { adapterFor: () => qbo })).toMatchObject({ ok: true, journals: 1, reposted: 0 })
    const tenth = await prisma.quickBooksJournal.findFirstOrThrow({ where: { connectionId, txnDate: new Date('2026-03-10') } })
    const index = qbo.posted.findIndex((e) => e.docNumber === docNumber(tenth.number))
    qbo.posted.splice(index, 1)
    expect(row((await reconcile()).accounts, 'Merchant Fees')).toEqual(expect.objectContaining({ platformCents: 3_510, quickBooksCents: 0 }))

    expect(await replayQuickBooksDate(orgId, entityId, '2026-03-10', { adapterFor: () => qbo })).toMatchObject({ ok: true, journals: 1, reposted: 1 })
    expect(await replayQuickBooksDate(orgId, entityId, '2026-03-10', { adapterFor: () => qbo })).toMatchObject({ ok: true, reposted: 0 })
    expect(qbo.posted.filter((e) => e.docNumber === docNumber(tenth.number))).toHaveLength(1)
    const clean = await reconcile()
    for (const account of clean.accounts) expect(account.quickBooksCents).toBe(account.platformCents)
    expect(clean.problems.map((p) => p.kind).sort()).toEqual(['excluded', 'missing_fee'])

    expect(await replayQuickBooksDate(orgId, entityId, '2026-03-20', { adapterFor: () => qbo })).toMatchObject({ ok: false, error: /No journal/ })
  })

  it('lets only one run post per connection at a time', async () => {
    const [a, b] = await Promise.all([sync(), sync()])
    expect([a[0]!.outcome, b[0]!.outcome].sort()).toEqual(['busy', 'synced'])
  })
})
