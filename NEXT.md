# Next session

## R-220 is pushed. First confirm its CI run went green, then pick up R-221: accrual-basis income is missing every month of subscription rent

R-220 shipped as `1807fcd` (SHA recorded in the follow-up commit). **Read CI on the run itself with `gh run list --limit 5`.** If it is red, fix that first. Do not copy a CI line forward.

**Start here:** `docs/prds/06-backlog.md`, row 208 / **R-221**.

## What R-221 is, in one paragraph

`taxExportFacts` ([apps/web/lib/tax/queries.ts](apps/web/lib/tax/queries.ts), ~line 106) picks the income table off the basis: cash reads `LedgerEntry` rows carrying a payment, accrual reads the `Charge` table. D-11/D-40 settled that the subscription's rent line mints **no `Charge` row**, so accrual income is only late fees, prorations and other charge-minting extras. Measured on `rental_demo` at R-220: **14 `LedgerEntry` rows of type `CHARGE` with no `chargeId` carry $26,550 of rent that accrual cannot see**, against 5 charge-linked rows worth $4,770.75 that it can. On screen: an operating report reading `$851.61` income for a house billing $2,200/month, economic occupancy of **2%**, and a Schedule E accrual line that understates rent income.

The candidate source is the ledger's own `CHARGE` rows. **The real work is the argument that the charge-linked ones are not then counted twice**, plus deciding what a waived charge means on the ledger side (accrual currently excludes `waivedAt`; the ledger records a reversing entry instead). `packages/core/tax` already asserts a reconciliation identity — extend that test rather than writing a second one.

## What R-220 established (D-238)

- Section names on the property and unit pages are a **contract**: PROP-01 and PROP-02 name Units, Leases, Maintenance, Documents and Financials, and two e2e tests assert them. Renaming one goes red on both projects.
- `WORK_ORDER_STATUS_LABELS` now lives in `packages/core/workorders`. Do not make a fifth local copy.
- A `next/link` to an `/api/…` byte route makes Next prefetch the bytes on every render. Download links are `<a>`.
- The demo seed must only write states the product can produce. Three did not.

## Standing gaps R-220 could not close

- **The deposit-slip and offline-payment flows need proved MFA**, which `db:seed:demo-access` cannot mint, so `/money/deposits` has still never been seen with a batch in it.
- **No demo rows** for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and **no guarantor portal login**.
- **Whether a deploy ever re-runs `db:seed`** — and so whether production's roles gain a permission a release adds — is unknown, and recorded as unknown.

## Still open from R-218

- Packet photographs are listed but not embedded.
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older still stands; it is in git history at `e9352b8:NEXT.md`.
