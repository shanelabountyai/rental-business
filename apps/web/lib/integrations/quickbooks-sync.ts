import 'server-only'

import {
  type AccountKey,
  type AccountingAdapter,
  type ExternalRef,
  type JournalFact,
  type SyncLedgerRow,
  SimulatedAccountingAdapter,
  buildJournalEntry,
  classifyLedgerEntry,
  postOnce,
  processingFeeFact,
} from '@rental/core/accounting'
import { type BusinessDate, businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { type Prisma, type QuickBooksConnection, prisma } from '@rental/db'
import { quickBooksAccessToken } from './quickbooks.ts'

// The nightly QuickBooks sync (R-282a, PRD 09 Q3-Q5, Q7; D-312, D-393, D-397).
//
// TWO PHASES, and the split is what makes it idempotent.
//
// PLAN, under a per-connection lock: every unsynced ledger entry of the
// entity whose posting day has ENDED in its property's zone is classified on
// the connection's basis, grouped by (property, day), and fixed to a new
// `QuickBooksJournal` by a `QuickBooksSyncLink` per entry. Nothing is planned
// while any account or property it needs is unmapped: a partial sync leaves
// the books inconsistent, a blocked one only leaves them late.
//
// POST: every PENDING journal is rebuilt from exactly its linked entries and
// posted with `postOnce` under its own DocNumber. A lost response is retried
// next run with the same DocNumber and the same lines, so QuickBooks sees one
// entry. A DocNumber per (property, day) instead would be wrong: an entry
// projected tomorrow for today would find today's DocNumber already posted
// and be skipped for ever.
//
// Payments post gross to Undeposited Funds, and the fee Stripe kept from each
// one posts in the same journal as a Merchant Fees line (R-282b, D-398), so
// the net is what reached the bank. A fee read after its journal posted is
// not added later. Entries projected before the connection existed are R-284's
// backfill, not this job's.
//
// ONE RUN AT A TIME PER CONNECTION (R-283). "Sync now", "replay date" and the
// cron can overlap, and two posters both finding a DocNumber missing would
// both post it: a duplicate in somebody's books. The later one steps aside.

/// Pending entries planned per connection per run.
// ponytail: a fixed batch; the rest wait for the next night. R-284's backfill
// is the path for history, so a normal night is far below this.
const PLAN_BATCH = 5_000

export type AdapterFor = (connection: { realmId: string; accessToken: string }) => AccountingAdapter

// ponytail: the simulated company file lives in process memory, so it forgets
// between serverless invocations. Harmless for a simulator; the real Intuit
// driver replaces this whole function.
const simulatedFiles = new Map<string, SimulatedAccountingAdapter>()
export const simulatedAdapterFor: AdapterFor = ({ realmId }) => {
  let file = simulatedFiles.get(realmId)
  if (!file) simulatedFiles.set(realmId, (file = new SimulatedAccountingAdapter()))
  return file
}

export type ConnectionSync =
  | { connectionId: string; outcome: 'synced'; planned: number; posted: number; excluded: number }
  | { connectionId: string; outcome: 'blocked' | 'failed' | 'not_connected' | 'busy'; reason: string }

export const docNumber = (journalNumber: number) => `RB-${journalNumber}`

/** Every connected entity of one org (or just one), one after another. Never throws. */
export async function syncQuickBooks(
  orgId: string,
  {
    now = new Date(),
    adapterFor = simulatedAdapterFor,
    legalEntityId,
  }: { now?: Date; adapterFor?: AdapterFor; legalEntityId?: string } = {},
): Promise<ConnectionSync[]> {
  const connections = await prisma.quickBooksConnection.findMany({
    where: { orgId, status: 'CONNECTED', legalEntityId },
    orderBy: { createdAt: 'asc' },
  })
  const results: ConnectionSync[] = []
  for (const connection of connections) {
    results.push(await syncConnection(connection, now, adapterFor))
  }
  return results
}

async function syncConnection(connection: QuickBooksConnection, now: Date, adapterFor: AdapterFor): Promise<ConnectionSync> {
  const connectionId = connection.id
  // Also what keeps an idle refresh token inside Intuit's 100 days (R-280).
  const token = await quickBooksAccessToken(connection.legalEntityId, now)
  if (!token.ok) return { connectionId, outcome: 'not_connected', reason: token.reason }

  try {
    const run = await exclusively(connectionId, async (): Promise<ConnectionSync> => {
      const plan = await planJournals(connection, now)
      if (plan.missing) return await stop(connectionId, 'blocked', plan.missing)
      const posted = await postJournals(connection, adapterFor({ realmId: token.realmId, accessToken: token.accessToken }), {
        status: 'PENDING',
      })
      if (posted.problem) return await stop(connectionId, 'blocked', posted.problem)
      await prisma.quickBooksConnection.update({ where: { id: connectionId }, data: { lastSyncedAt: now, syncProblem: null } })
      return { connectionId, outcome: 'synced', planned: plan.planned, posted: posted.count, excluded: plan.excluded }
    })
    return run ?? { connectionId, outcome: 'busy', reason: BUSY }
  } catch (error) {
    return stop(connectionId, 'failed', error instanceof Error ? error.message : String(error))
  }
}

const BUSY = 'Another sync or replay for this entity is running. Try again in a minute.'

/// Runs `fn` holding this connection's post lock, or returns null at once if
/// another run holds it. The lock lives as long as the transaction, which
/// `fn` does not use: it only has to outlive `fn`.
async function exclusively<T>(connectionId: string, fn: () => Promise<T>): Promise<T | null> {
  return prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`quickbooks-post:${connectionId}`})) AS locked`
      return row?.locked ? fn() : null
    },
    { timeout: 10 * 60_000, maxWait: 10_000 },
  )
}

export type ReplayResult =
  | { ok: true; connectionId: string; journals: number; reposted: number }
  | { ok: false; connectionId?: string; error: string }

/**
 * Sends every journal dated `day` through `postOnce` again, posted ones too
 * (R-283, PRD 09 Q10). One QuickBooks still holds is found by its DocNumber
 * and left alone; one a bookkeeper deleted is posted again with the same
 * DocNumber and lines. Plans nothing: the next sync does that.
 */
export async function replayQuickBooksDate(
  orgId: string,
  legalEntityId: string,
  day: BusinessDate,
  { now = new Date(), adapterFor = simulatedAdapterFor }: { now?: Date; adapterFor?: AdapterFor } = {},
): Promise<ReplayResult> {
  const connection = await prisma.quickBooksConnection.findFirst({ where: { orgId, legalEntityId, status: 'CONNECTED' } })
  if (!connection) return { ok: false, error: 'That entity is not connected to QuickBooks.' }
  const connectionId = connection.id
  const token = await quickBooksAccessToken(legalEntityId, now)
  if (!token.ok) return { ok: false, connectionId, error: token.reason }
  const run = await exclusively(connectionId, () =>
    postJournals(connection, adapterFor({ realmId: token.realmId, accessToken: token.accessToken }), {
      txnDate: businessDateToUtc(day),
      status: { in: ['PENDING', 'POSTED'] },
    }),
  )
  if (!run) return { ok: false, connectionId, error: BUSY }
  if (run.problem) return { ok: false, connectionId, error: run.problem }
  if (run.journals === 0) return { ok: false, connectionId, error: 'No journal is dated that day for this entity.' }
  return { ok: true, connectionId, journals: run.journals, reposted: run.reposted }
}

async function stop(connectionId: string, outcome: 'blocked' | 'failed', reason: string): Promise<ConnectionSync> {
  await prisma.quickBooksConnection.update({ where: { id: connectionId }, data: { syncProblem: reason } })
  return { connectionId, outcome, reason }
}

export const ledgerSelect = {
  id: true,
  type: true,
  amountCents: true,
  paymentId: true,
  propertyId: true,
  occurredAt: true,
  charge: { select: { type: true } },
} satisfies Prisma.LedgerEntrySelect

type LedgerPick = Prisma.LedgerEntryGetPayload<{ select: typeof ledgerSelect }>

export const toRow = (entry: LedgerPick): SyncLedgerRow => ({
  id: entry.id,
  type: entry.type,
  amountCents: entry.amountCents,
  paymentId: entry.paymentId,
  chargeType: entry.charge?.type ?? null,
})

/// Cash reads only rows where money moved (and the adjustments it excludes),
/// so the charges it ignores are not re-read every night for ever.
export const basisWhere = (basis: QuickBooksConnection['basis']): Prisma.LedgerEntryWhereInput =>
  basis === 'CASH' ? { OR: [{ paymentId: { not: null } }, { type: { in: ['PAYMENT', 'ADJUSTMENT'] } }] } : {}

export async function mappingsOf(connectionId: string, tx: Prisma.TransactionClient = prisma) {
  const rows = await tx.quickBooksMapping.findMany({ where: { connectionId } })
  const ref = (row: (typeof rows)[number]): ExternalRef => ({ id: row.externalId, name: row.externalName })
  return {
    accounts: new Map(rows.filter((r) => r.kind === 'ACCOUNT').map((r) => [r.platformKey, ref(r)])),
    properties: new Map(rows.filter((r) => r.kind === 'PROPERTY').map((r) => [r.platformKey, ref(r)])),
  }
}

function unmapped(
  mapping: Awaited<ReturnType<typeof mappingsOf>>,
  accounts: Iterable<AccountKey>,
  properties: Iterable<{ id: string; name: string }>,
): string | null {
  const accountGaps = [...new Set(accounts)].filter((key) => !mapping.accounts.has(key)).sort()
  const propertyGaps = [...properties].filter((p) => !mapping.properties.has(p.id)).map((p) => p.name).sort()
  if (accountGaps.length === 0 && propertyGaps.length === 0) return null
  const parts = [
    accountGaps.length > 0 ? `accounts ${accountGaps.join(', ')}` : null,
    propertyGaps.length > 0 ? `properties ${propertyGaps.join(', ')}` : null,
  ].filter(Boolean)
  return `Nothing synced: not mapped in QuickBooks yet (${parts.join('; ')}). Run db:quickbooks-map for this entity.`
}

async function planJournals(connection: QuickBooksConnection, now: Date) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quickbooks-sync:${connection.id}`}))`
      const properties = await tx.property.findMany({
        where: { orgId: connection.orgId, legalEntityId: connection.legalEntityId },
        select: { id: true, name: true, timezone: true },
      })
      const byId = new Map(properties.map((p) => [p.id, p]))
      const entries = await tx.ledgerEntry.findMany({
        where: {
          propertyId: { in: [...byId.keys()] },
          createdAt: { gte: connection.createdAt },
          quickBooksSyncLink: null,
          ...basisWhere(connection.basis),
        },
        select: ledgerSelect,
        orderBy: { id: 'asc' },
        take: PLAN_BATCH,
      })

      const groups = new Map<string, { propertyId: string; day: string; ids: string[] }>()
      const excluded: { ledgerEntryId: string; reason: string }[] = []
      const accounts: AccountKey[] = []
      const feePayments = new Set<string>()
      for (const entry of entries) {
        const zone = byId.get(entry.propertyId)!.timezone
        const day = businessDate(entry.occurredAt, zone)
        // The day is still running there: wait, so a day is normally one entry.
        if (day >= businessDate(now, zone)) continue
        const classified = classifyLedgerEntry(toRow(entry), connection.basis)
        if (classified.kind === 'not_on_basis') continue
        if (classified.kind === 'excluded') {
          excluded.push({ ledgerEntryId: entry.id, reason: classified.reason })
          continue
        }
        accounts.push(classified.fact.debit, classified.fact.credit)
        if (entry.paymentId && entry.amountCents < 0) feePayments.add(entry.paymentId)
        const key = `${entry.propertyId}|${day}`
        const group = groups.get(key) ?? { propertyId: entry.propertyId, day, ids: [] }
        group.ids.push(entry.id)
        groups.set(key, group)
      }

      if (feePayments.size > 0 && (await tx.stripeProcessingFee.count({ where: { paymentId: { in: [...feePayments] } } })) > 0) {
        accounts.push('MERCHANT_FEES')
      }
      const missing = unmapped(
        await mappingsOf(connection.id, tx),
        accounts,
        [...groups.values()].map((g) => byId.get(g.propertyId)!),
      )
      if (missing) return { missing, planned: 0, excluded: 0 }

      for (const group of groups.values()) {
        const journal = await tx.quickBooksJournal.create({
          data: {
            orgId: connection.orgId,
            connectionId: connection.id,
            propertyId: group.propertyId,
            txnDate: businessDateToUtc(group.day),
          },
          select: { id: true },
        })
        await tx.quickBooksSyncLink.createMany({
          data: group.ids.map((ledgerEntryId) => ({
            ledgerEntryId,
            orgId: connection.orgId,
            connectionId: connection.id,
            journalId: journal.id,
          })),
        })
      }
      await tx.quickBooksSyncLink.createMany({
        data: excluded.map(({ ledgerEntryId, reason }) => ({
          ledgerEntryId,
          excludedReason: reason,
          orgId: connection.orgId,
          connectionId: connection.id,
        })),
      })
      return { missing: null, planned: groups.size, excluded: excluded.length }
    },
    { timeout: 60_000 },
  )
}

/**
 * The Merchant Fees facts for one journal (R-282b). A payment allocated over
 * several debts has several entries, and a batch boundary can put them in
 * different journals, so its fee goes only in the journal holding its
 * lowest-id money-in entry that reached a journal. Every rebuild of the same
 * journal picks the same one.
 */
async function feeFacts(journalId: string, entries: Pick<LedgerPick, 'paymentId' | 'amountCents'>[]) {
  const paymentIds = [...new Set(entries.filter((e) => e.paymentId && e.amountCents < 0).map((e) => e.paymentId!))]
  if (paymentIds.length === 0) return []
  const fees = await prisma.stripeProcessingFee.findMany({
    where: { paymentId: { in: paymentIds } },
    orderBy: { paymentId: 'asc' },
    select: {
      amountCents: true,
      payment: {
        select: {
          ledgerEntries: {
            where: { amountCents: { lt: 0 }, quickBooksSyncLink: { journalId: { not: null } } },
            orderBy: { id: 'asc' },
            take: 1,
            select: { id: true, quickBooksSyncLink: { select: { journalId: true } } },
          },
        },
      },
    },
  })
  return fees.flatMap(({ amountCents, payment }) => {
    const anchor = payment.ledgerEntries[0]
    return anchor?.quickBooksSyncLink?.journalId === journalId ? [processingFeeFact(anchor.id, amountCents)] : []
  })
}

/**
 * The facts one planned journal posts: its linked entries on the
 * connection's basis, plus the fees anchored in it. Rebuilt the same way on
 * every retry, and by the reconciliation page (R-283).
 */
export async function journalFacts(
  connection: Pick<QuickBooksConnection, 'basis'>,
  journal: { id: string; links: { ledgerEntry: LedgerPick }[] },
): Promise<JournalFact[]> {
  const facts = journal.links.map(({ ledgerEntry }) => {
    const classified = classifyLedgerEntry(toRow(ledgerEntry), connection.basis)
    // Planned as a fact under the same basis, and the basis cannot change.
    if (classified.kind !== 'fact') throw new Error(`Ledger entry ${ledgerEntry.id} no longer classifies as a fact.`)
    return classified.fact
  })
  facts.push(...(await feeFacts(journal.id, journal.links.map(({ ledgerEntry }) => ledgerEntry))))
  return facts
}

export const journalSelect = {
  id: true,
  number: true,
  status: true,
  externalId: true,
  lastError: true,
  propertyId: true,
  txnDate: true,
  links: { select: { ledgerEntry: { select: ledgerSelect } }, orderBy: { ledgerEntryId: 'asc' } },
} satisfies Prisma.QuickBooksJournalSelect

/// Oldest first, stopping at the first failure so the books fill in order.
/// Callers hold `exclusively`.
async function postJournals(connection: QuickBooksConnection, adapter: AccountingAdapter, where: Prisma.QuickBooksJournalWhereInput) {
  const journals = await prisma.quickBooksJournal.findMany({
    where: { ...where, connectionId: connection.id },
    orderBy: { number: 'asc' },
    select: journalSelect,
  })
  const mapping = await mappingsOf(connection.id)
  let count = 0
  let reposted = 0
  for (const journal of journals) {
    const draft = buildJournalEntry({
      docNumber: docNumber(journal.number),
      txnDate: utcToBusinessDate(journal.txnDate),
      propertyId: journal.propertyId,
      facts: await journalFacts(connection, journal),
    })
    if (!draft) {
      await prisma.quickBooksJournal.update({ where: { id: journal.id }, data: { status: 'EMPTY' } })
      continue
    }
    const property = mapping.properties.get(journal.propertyId)
    const accounts = Object.fromEntries(draft.lines.map((line) => [line.account, mapping.accounts.get(line.account)]))
    if (!property || Object.values(accounts).some((ref) => !ref)) {
      // A mapping removed between plan and post.
      return { count, journals: journals.length, reposted, problem: `Journal ${draft.docNumber} lost its QuickBooks mapping; run db:quickbooks-map for this entity.` }
    }
    try {
      const posted = await postOnce(adapter, {
        ...draft,
        accounts: accounts as Record<AccountKey, ExternalRef>,
        property: { ...property, field: connection.propertyField },
      })
      // A replay that found the entry still there changes nothing.
      if (journal.status !== 'POSTED' || journal.externalId !== posted.externalId) {
        if (journal.status === 'POSTED') reposted += 1
        await prisma.quickBooksJournal.update({
          where: { id: journal.id },
          data: { status: 'POSTED', externalId: posted.externalId, postedAt: new Date(), lastError: null },
        })
      }
      count += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await prisma.quickBooksJournal.update({ where: { id: journal.id }, data: { lastError: message } })
      return {
        count,
        journals: journals.length,
        reposted,
        problem: `QuickBooks refused or did not answer for ${draft.docNumber}: ${message} It is retried next run.`,
      }
    }
  }
  return { count, journals: journals.length, reposted, problem: null }
}
