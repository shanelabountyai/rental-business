# 09 — QuickBooks Accounting Sync PRD
## One-way nightly push from the ledger projection into QuickBooks Online

| | |
|---|---|
| **Document status** | Draft v0.1 — not yet reviewed, nothing in it is built |
| **Date** | October 20, 2026 |
| **Prepared by** | Shane LaBounty (realtor prospect follow-up; companion to PRD 08) |
| **Source** | Claude Docs "QuickBooks Accounting Sync PRD" — https://claude.ai/artifact/UzLuiyCxTdRYPJ7gmV8Esu |
| **Companion files** | `00-master-prd.md` · `08-messaging-and-white-label.md` · `06-backlog.md` · `07-decisions.md` (**overrides this document where they conflict**) · `../PROGRESS.md` |

> **On the numbering.** As in PRD 08, every R-, D- and OQ- number below is a **draft placeholder that collides** with a settled one (R-115–R-120 are built rows, D-14/D-15 are settled, OQ-16–OQ-18 do not exist yet but follow PRD 08's colliding block). Renumbered when appended, not before.

> **Conflicts with settled decisions — resolve before any row is appended.**
> - **The ledger is `LedgerEntry`, not `LedgerLine`, and it is append-only by trigger.** §4's nullable `qboJournalEntryId`/`qboDocNumber`/`syncedAt`/`syncRunId` columns would be written by an UPDATE after the sync, which the database refuses. Sync state needs its own table keyed by `ledgerEntryId` (the `WorkOrderMessageLink` pattern).
> - **The platform ledger is not the source of truth.** D-11 makes Stripe the system of record and `LedgerEntry` its projection; §1 and D-14 below say the reverse. The one-way-push design survives, but its wording and its reconciliation target change.
> - **Bookkeeping basis is already settled as a parameter (D-71, partial answer to OQ-8)**, so OQ-18 below is partly answered.

## 1. Context and recommendation

Recommendation: a one-way, nightly push from the platform's append-only ledger into QuickBooks Online (QBO), with the platform as the source of truth for rent and the owner's bookkeeper closing the books in QuickBooks. Never sync QBO back into the ledger.

Why: the rental platform already records every rent charge, payment, fee, deposit and vendor payout as ledger lines in integer cents with reversing corrections (master PRD §13). Small landlord groups like the realtor's 20-property portfolio almost always keep their books in QuickBooks for their CPA. Today that means re-keying or CSV exports. A sync adapter removes that work and is a concrete selling point in the white-label offer ([Renter Text Messaging PRD](https://claude.ai/code/artifact/fa930e0e-b8c7-4c97-8b9f-db871442f231), OQ-11).

QuickBooks Desktop is out of scope; QBO's REST API and OAuth 2.0 are the only target.

## 2. Scope, non-goals and success metrics

**In scope**

- Per-organization QBO connection via OAuth 2.0 from the settings page; owner can connect, disconnect and see last-sync status
- Nightly push of new ledger lines since the last successful sync, grouped by day and property into QBO journal entries
- Chart-of-accounts mapping screen: owner maps platform categories (rent income, late fees, security deposits held, repairs, management fees, owner draws) to QBO accounts; sensible defaults proposed
- Property as QBO Class (or Location) so the CPA can run P&L by property
- Renters as QBO Customers and vendors as QBO Vendors, created on first reference
- Reconciliation report: platform total vs QBO total per month, with drill-down on mismatches
- Manual "sync now" and replay of a failed day

**Out of scope**

- Pulling bills, expenses or bank feeds from QBO back into the platform
- QuickBooks Desktop, Xero, Wave (adapter interface should allow them later)
- Invoice-level sync (one QBO invoice per rent charge); journal entries are sufficient for the CPA and far fewer API calls
- Payroll, 1099 generation

**Success metrics**

| Metric | Target |
| --- | --- |
| Month-end platform vs QBO variance | $0.00 for synced accounts |
| Nightly sync completion for a 20-property org | < 2 min |
| Owner-completed account mapping without support | > 80% of orgs |
| Failed-day replay success | 100% within 24 h |

## 3. Requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| Q1 | Connect to QBO via Intuit OAuth 2.0; store refresh token encrypted in `OrgIntegration` (provider = quickbooks); refresh before expiry; surface "reconnect needed" on failure | Must |
| Q2 | Mapping screen lists every platform ledger category with a QBO account dropdown fetched live; unmapped categories block sync with a clear message | Must |
| Q3 | Nightly job (property-local midnight + 1 h, existing scheduler) selects ledger lines with `syncedAt IS NULL`, groups by posting date and property, posts one QBO JournalEntry per group, stores QBO id and `syncedAt` on each line | Must |
| Q4 | Reversing corrections in the ledger post as reversing journal entries, never edits or deletes in QBO | Must |
| Q5 | Idempotency: every JournalEntry carries a platform-generated `DocNumber`; a retry checks for it before posting | Must |
| Q6 | Each property maps to a QBO Class (owner chooses Class or Location at setup; default Class) | Must |
| Q7 | Security deposits post to a liability account, not income | Must |
| Q8 | Stripe processing fees post as an expense line in the same entry as the payment, so net deposit matches the bank feed | Must |
| Q9 | Reconciliation page: month picker, platform total vs QBO total per mapped account, list of unsynced or failed lines | Must |
| Q10 | "Sync now" and "replay date" actions, Owner/Admin only, logged to audit | Should |
| Q11 | Backfill: on first connect, offer to push history from a chosen start date in daily batches respecting QBO rate limits (500 req/min per realm) | Should |
| Q12 | Adapter interface `AccountingAdapter` with QBO as first implementation and a simulated adapter for tests, matching the master PRD §14 pattern | Must |

## 4. Data model additions and ledger-to-QBO mapping

| Table | Key fields | Notes |
| --- | --- | --- |
| `OrgIntegration` | orgId, provider = quickbooks, realmId, encryptedRefreshToken, tokenExpiresAt, status, connectedBy, connectedAt | Shared table from the white-label PRD |
| `AccountingMapping` | orgId, ledgerCategory, qboAccountId, qboAccountName, qboAccountType | One row per category |
| `AccountingClassMap` | orgId, propertyId, qboClassId | Property → Class |
| `AccountingSyncRun` | id, orgId, startedAt, finishedAt, status, linesAttempted, linesSynced, errorJson | One row per nightly or manual run |
| `LedgerLine` (existing) | + qboJournalEntryId, qboDocNumber, syncedAt, syncRunId | Nullable; never mutated after sync except by a reversing line |

**Default category → QBO account mapping**

| Platform ledger category | QBO account (default) | Type |
| --- | --- | --- |
| Rent charge / payment | Rental Income | Income |
| Late fee | Late Fee Income | Income |
| Security deposit received | Security Deposits Held | Other Current Liability |
| Security deposit returned / applied | Security Deposits Held | Other Current Liability |
| Repair / maintenance payout | Repairs and Maintenance | Expense |
| Stripe processing fee | Merchant Fees | Expense |
| Management fee | Management Fees | Expense |
| Owner draw | Owner Distributions | Equity |
| Undeposited / in-transit | Undeposited Funds | Other Current Asset |

Each journal entry balances: cash or Undeposited Funds on one side, income/liability/expense on the other, with the property's Class on every line.

## 5. Backlog rows, decisions and open questions

**Backlog additions (append to `docs/prds/06-backlog.md`, after R-114)**

| # | ID | Item | PRD/Feature | Size | Depends on | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| 115 | R-115 | AccountingAdapter interface + simulated adapter | Q12 | S | R-111 | 5 |
| 116 | R-116 | QBO OAuth connect/disconnect + token refresh | Q1 | M | R-111 | 5 |
| 117 | R-117 | Account mapping screen + defaults + Class mapping | Q2, Q6 | M | R-116 | 5 |
| 118 | R-118 | Nightly sync job, journal-entry builder, idempotent DocNumber | Q3–Q5, Q7, Q8 | L | R-117 | 5 |
| 119 | R-119 | Reconciliation page + sync-now + replay | Q9, Q10 | M | R-118 | 5 |
| 120 | R-120 | Historical backfill with rate limiting | Q11 | M | R-118 | 6 |

**Decisions**

- D-14: Platform ledger is the source of truth; QBO sync is one-way push only.
- D-15: Journal entries, not invoices, are the sync unit.

**Open questions**

- [ ] OQ-16: Does the realtor's group use QBO today, and one company file or one per entity? (One file per entity means one connection per entity under the org.)
- [ ] OQ-17: Does their CPA want Class or Location for property reporting?
- [ ] OQ-18: Cash or accrual basis? (Accrual means rent charges post when billed; cash means when paid. Default accrual, with a per-org toggle.)
