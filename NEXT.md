# Next session

## R-221 is pushed. Confirm its CI run, then pick the next Arc 5 row

R-221 shipped as `deed6de`, SHA recorded in `209d0b4`. **Read CI with `gh run list --limit 5` before starting** — do not copy a CI line forward from here; this file's claim is only that the push happened.

**Start here:** `docs/prds/06-backlog.md`, the first ⬜ row after 208.

## What R-221 established (D-239)

- **Accrual income = the `Charge` table + the ledger's unlinked `CHARGE`/`REVERSAL` rows.** `LEDGER_INCOME_WHERE` in [apps/web/lib/tax/queries.ts](apps/web/lib/tax/queries.ts) is keyed by basis. The accrual filter is the exact complement of the cash one, so double-counting is impossible by construction rather than by care: `webhook.ts` writes one LINKED entry per `Charge` it raised plus one UNLINKED remainder, and the `Charge` table owns the linked side.
- **`buildTaxExport`'s ledger sign flip is now conditioned on the basis.** A cash receipt is negative (it reduces what is owed); an accrual charge is positive (it raises the obligation). Anything that adds a new ledger-sourced income fact must say which of those it is, or it reports rent with the wrong sign — which is what the first draft of this fix did.
- **`CREDIT` and `ADJUSTMENT` are in `LedgerEntryType` and nothing writes them.** All six `ledgerEntry.create` calls live in `webhook.ts`. If you add a writer, the accrual type list in `LEDGER_INCOME_WHERE` is one of the places that has to know.
- **`operatingReport` re-groups the export's lines, it does not re-fetch.** Money fixed in `taxExportFacts` reaches both the Schedule E export and the operating report; do not add a second income pipeline.

## Standing gaps R-221 left

- **No demo `REVERSAL` rows exist**, so the void/waiver half of the accrual read is covered by unit test only, never walked.
- **Nothing backfills or re-reports.** An export archived under R-081d keeps its old figure, and no screen says an accrual run today will differ from last year's packet.
- **`/reports/operating` was verified by SQL, not in a browser.** Bluebonnet Lane House 2026 went $851.61 → $7,451.61; the screen itself belongs to the next D-28 walk.

## Still open from R-220

- **Deposit-slip and offline-payment flows need proved MFA**, which `db:seed:demo-access` cannot mint, so `/money/deposits` has never been seen with a batch in it.
- **No demo rows** for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and **no guarantor portal login**.
- **Whether a deploy ever re-runs `db:seed`** — and so whether production's roles gain a permission a release adds — is unknown, and recorded as unknown.

## Still open from R-218

- Packet photographs are listed but not embedded.
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older still stands; it is in git history at `e9352b8:NEXT.md`.
