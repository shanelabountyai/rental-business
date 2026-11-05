import 'server-only'

import { ACCOUNT_DEFAULTS, type AccountKey, type JournalFact, classifyLedgerEntry, isMoneyMoving, processingFeeFact } from '@rental/core/accounting'
import { type BusinessDate, businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { quickBooksAccessToken } from './quickbooks.ts'
import {
  type AdapterFor,
  basisWhere,
  docNumber,
  journalFacts,
  journalSelect,
  ledgerSelect,
  mappingsOf,
  simulatedAdapterFor,
  toRow,
} from './quickbooks-sync.ts'

// The reconciliation page's numbers (R-283, PRD 09 Q9).
//
// PLATFORM: what the ledger says the month's books hold. Every planned
// journal dated in the month, whatever its status, rebuilt exactly as the
// sync posts it, plus every entry dated in the month that no run has planned
// yet. Excluded entries are never posted, so they are listed, not totalled.
// Entries projected before the connection existed are R-284's backfill and
// are left out of both sides' story.
//
// QUICKBOOKS: the company file's own journal entries for the month, read
// back through the adapter (D-27: never from our tables), and only the ones
// carrying our DocNumbers. A bookkeeper's own entries to the same account
// are theirs to reconcile; a duplicate of ours is counted, and shows.
//
// Both sides are compared per QuickBooks ACCOUNT, not per platform key: two
// keys mapped to one account are one number in the company file.

/// Debit positive, credit negative, in cents.
export interface AccountRow {
  key: string
  name: string
  platformCents: number
  quickBooksCents: number | null
}

export interface ProblemLine {
  kind: 'not_synced' | 'waiting' | 'excluded' | 'failed' | 'pending' | 'missing_fee'
  day: BusinessDate
  property: string
  text: string
  amountCents: number | null
}

export type Reconciliation =
  | {
      ok: true
      month: string
      from: BusinessDate
      to: BusinessDate
      accounts: AccountRow[]
      quickBooksError: string | null
      problems: ProblemLine[]
    }
  | { ok: false; error: string }

const OUR_DOC_NUMBER = /^RB-\d+$/

export function monthRange(month: string): { from: BusinessDate; to: BusinessDate } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) return null
  const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate()
  return { from: `${month}-01` as BusinessDate, to: `${month}-${String(last).padStart(2, '0')}` as BusinessDate }
}

export async function reconcileQuickBooks(
  orgId: string,
  legalEntityId: string,
  month: string,
  { now = new Date(), adapterFor = simulatedAdapterFor }: { now?: Date; adapterFor?: AdapterFor } = {},
): Promise<Reconciliation> {
  const range = monthRange(month)
  if (!range) return { ok: false, error: 'Choose a month.' }
  const { from, to } = range
  const connection = await prisma.quickBooksConnection.findFirst({ where: { orgId, legalEntityId, status: 'CONNECTED' } })
  if (!connection) return { ok: false, error: 'That entity is not connected to QuickBooks.' }

  const properties = await prisma.property.findMany({
    where: { orgId, legalEntityId },
    select: { id: true, name: true, timezone: true },
  })
  const byId = new Map(properties.map((p) => [p.id, p]))
  const dayOf = (instant: Date, propertyId: string) => businessDate(instant, byId.get(propertyId)!.timezone)
  const inMonth = (day: BusinessDate) => day >= from && day <= to
  // Instants a day either side, then each row's own zone decides.
  const window = { gte: new Date(businessDateToUtc(from).getTime() - 86_400_000), lt: new Date(businessDateToUtc(to).getTime() + 2 * 86_400_000) }
  const propertyIds = [...byId.keys()]

  const platform = new Map<AccountKey, number>()
  const add = (fact: JournalFact) => {
    platform.set(fact.debit, (platform.get(fact.debit) ?? 0) + fact.amountCents)
    platform.set(fact.credit, (platform.get(fact.credit) ?? 0) - fact.amountCents)
  }
  const problems: ProblemLine[] = []
  const name = (propertyId: string) => byId.get(propertyId)?.name ?? propertyId

  // Planned journals.
  const journals = await prisma.quickBooksJournal.findMany({
    where: { connectionId: connection.id, txnDate: { gte: businessDateToUtc(from), lte: businessDateToUtc(to) }, status: { not: 'EMPTY' } },
    orderBy: { number: 'asc' },
    select: journalSelect,
  })
  for (const journal of journals) {
    const facts = await journalFacts(connection, journal)
    facts.forEach(add)
    if (journal.status === 'POSTED') continue
    const debits = facts.reduce((n, f) => n + Math.abs(f.amountCents), 0)
    problems.push({
      kind: journal.lastError ? 'failed' : 'pending',
      day: utcToBusinessDate(journal.txnDate),
      property: name(journal.propertyId),
      text: journal.lastError
        ? `${docNumber(journal.number)} failed: ${journal.lastError}`
        : `${docNumber(journal.number)} is planned and not posted yet.`,
      amountCents: debits,
    })
  }

  // Excluded when planned.
  const excluded = await prisma.quickBooksSyncLink.findMany({
    where: { connectionId: connection.id, excludedReason: { not: null }, ledgerEntry: { occurredAt: window } },
    select: { excludedReason: true, ledgerEntry: { select: { propertyId: true, occurredAt: true, amountCents: true } } },
  })
  for (const { excludedReason, ledgerEntry } of excluded) {
    const day = dayOf(ledgerEntry.occurredAt, ledgerEntry.propertyId)
    if (!inMonth(day)) continue
    problems.push({ kind: 'excluded', day, property: name(ledgerEntry.propertyId), text: excludedReason!, amountCents: ledgerEntry.amountCents })
  }

  // Not planned yet.
  const unplanned = await prisma.ledgerEntry.findMany({
    where: {
      propertyId: { in: propertyIds },
      createdAt: { gte: connection.createdAt },
      quickBooksSyncLink: null,
      occurredAt: window,
      ...basisWhere(connection.basis),
    },
    select: ledgerSelect,
    orderBy: { id: 'asc' },
  })
  const unplannedPayments = new Map<string, string>()
  for (const entry of unplanned) {
    const day = dayOf(entry.occurredAt, entry.propertyId)
    if (!inMonth(day)) continue
    const classified = classifyLedgerEntry(toRow(entry), connection.basis)
    if (classified.kind === 'not_on_basis') continue
    if (classified.kind === 'excluded') {
      problems.push({ kind: 'excluded', day, property: name(entry.propertyId), text: classified.reason, amountCents: entry.amountCents })
      continue
    }
    add(classified.fact)
    if (entry.paymentId && entry.amountCents < 0 && !unplannedPayments.has(entry.paymentId)) unplannedPayments.set(entry.paymentId, entry.id)
    const waiting = day >= businessDate(now, byId.get(entry.propertyId)!.timezone)
    problems.push({
      kind: waiting ? 'waiting' : 'not_synced',
      day,
      property: name(entry.propertyId),
      text: `${isMoneyMoving(entry) ? 'Payment' : 'Charge'}: ${waiting ? 'its day has not ended yet.' : 'not synced yet; the next sync plans it.'}`,
      amountCents: entry.amountCents,
    })
  }
  // A fee travels with its payment's first planned entry, so it counts here
  // only while none of that payment's entries has reached a journal.
  if (unplannedPayments.size > 0) {
    const fees = await prisma.stripeProcessingFee.findMany({
      where: {
        paymentId: { in: [...unplannedPayments.keys()] },
        payment: { ledgerEntries: { none: { quickBooksSyncLink: { journalId: { not: null } } } } },
      },
      select: { paymentId: true, amountCents: true },
    })
    for (const fee of fees) add(processingFeeFact(unplannedPayments.get(fee.paymentId)!, fee.amountCents))
  }

  // Card and bank payments Stripe settled whose fee was never read (R-282b
  // does not retry a failed read): they posted gross.
  const feeless = await prisma.payment.findMany({
    where: {
      propertyId: { in: propertyIds },
      status: 'SETTLED',
      channel: { in: ['CARD', 'ACH'] },
      receivedByStaffId: null,
      processingFee: null,
      receivedAt: window,
    },
    select: { propertyId: true, receivedAt: true, amountCents: true },
    orderBy: { receivedAt: 'asc' },
  })
  for (const payment of feeless) {
    const day = dayOf(payment.receivedAt, payment.propertyId)
    if (!inMonth(day)) continue
    problems.push({
      kind: 'missing_fee',
      day,
      property: name(payment.propertyId),
      text: 'Stripe payment with no processing fee recorded: it posted gross, so the deposit will not match the bank.',
      amountCents: payment.amountCents,
    })
  }

  // QuickBooks' side.
  let quickBooks: Map<string, number> | null = null
  let quickBooksError: string | null = null
  const token = await quickBooksAccessToken(legalEntityId, now)
  if (!token.ok) {
    quickBooksError = token.reason
  } else {
    try {
      const entries = await adapterFor({ realmId: token.realmId, accessToken: token.accessToken }).listJournalEntries({ from, to })
      quickBooks = new Map()
      for (const entry of entries) {
        if (!OUR_DOC_NUMBER.test(entry.docNumber)) continue
        for (const line of entry.lines) {
          const signed = line.side === 'DEBIT' ? line.amountCents : -line.amountCents
          quickBooks.set(line.accountId, (quickBooks.get(line.accountId) ?? 0) + signed)
        }
      }
    } catch (error) {
      quickBooksError = `QuickBooks did not answer: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // Join on the company file's account.
  const mapping = await mappingsOf(connection.id)
  const rows = new Map<string, AccountRow>()
  for (const [key, cents] of platform) {
    const ref = mapping.accounts.get(key)
    const rowKey = ref ? ref.id : `unmapped:${key}`
    const row = rows.get(rowKey) ?? {
      key: rowKey,
      name: ref ? ref.name : `${ACCOUNT_DEFAULTS[key]} (not mapped)`,
      platformCents: 0,
      quickBooksCents: ref && quickBooks ? (quickBooks.get(ref.id) ?? 0) : null,
    }
    row.platformCents += cents
    rows.set(rowKey, row)
  }
  const names = new Map([...mapping.accounts.values()].map((ref) => [ref.id, ref.name]))
  for (const [accountId, cents] of quickBooks ?? []) {
    if (!rows.has(accountId)) rows.set(accountId, { key: accountId, name: names.get(accountId) ?? accountId, platformCents: 0, quickBooksCents: cents })
  }

  problems.sort((a, b) => a.day.localeCompare(b.day) || a.property.localeCompare(b.property))
  return {
    ok: true,
    month,
    from,
    to,
    accounts: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    quickBooksError,
    problems,
  }
}
