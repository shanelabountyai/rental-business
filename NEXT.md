# Next session

## R-242 is done (`56592f2`, SHA recorded in `d7a1c3e`). Push triggered a real CI run (code, not docs-only).

**CI run `35745971497` finished green** (`gh run list --limit 3`, confirmed 2026-09-22) — R-242's code changes are verified on `main`.

**What R-242 built:** resolved Milestone 17's OQ-6/OQ-9 staleness check (R-241's own leftover candidate) and closed the real gap it found. OQ-9 (Spanish) was pure staleness — D-122 answered and cut R-096 on 2026-08-24, a month before this session; the backlog's "Flagged gaps & conflicts" section (item 5) just never got updated. Fixed with an edit. OQ-6 (screening criteria) was correctly described as open but the write-up undersold what D-52's precedent had already answered (2026-08-18): R-060 shipped with a seeded, deliberately-unreviewed `ScreeningCriteria` v1 rather than blocking — the real gap was that nothing let an owner actually *record* a review. `JurisdictionRule` has a full admin surface (`/jurisdiction`, `/jurisdiction/new`); `ScreeningCriteria` had none. Built `/screening-criteria` + `/screening-criteria/new` (append-only versioning, `reviewedBy` required on every version — stricter than `JurisdictionRule`'s "only the founding version is blocked", since there's no founding-version exception here), two new portfolio-wide-only permissions (`screening.criteria.read`/`.write`, owner-only write), a `validateCriteriaInput` unit-tested in `packages/core/screening/criteria.ts`, and a read-only e2e spec. Recorded **D-255**. Full detail in `docs/PROGRESS.md`'s R-242 entry.

**Deliberately not e2e-tested on the write path**, and this is worth reading before anyone is tempted to "complete the coverage": `ScreeningCriteria` carries no scoping key at all — no state, no jurisdiction, no property. Versioning the real seeded v1 through the actual form in a test would permanently change which criteria govern every applicant in the shared `rental_test` database, for every concurrently-running spec and every future run, with no scoped row to clean up afterward. `e2e/screening-criteria.spec.ts` covers the read path and the permission gate only, against the real seeded data.

**A new permission needs a reseed to reach `rental_test`, and this bit the first e2e run this session.** `screening.criteria.read`/`.write` were added to `packages/core/rbac/permissions.ts`, but `Role` rows are database data (`seed.mts`'s own header: "roles-as-data, D-5") — the local `rental_test` database didn't have the new permission until `npm run db:seed:test` was re-run. Not a bug, just a step: any session that adds a permission needs a reseed before its own e2e run will pass. (CI seeds fresh every run, so this only ever bites locally.)

**Milestone 17 (Go-live hardening) still has one real candidate left, not yet scoped into a row.** From `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list (right after the Milestone 17 table):
- The carried-defects list below — each is a candidate row, not yet sized or ordered. Pick one, scope it into a real row (per this repo's convention: scope before coding), and build it.
- The jurisdiction/screening-criteria legal-review gate itself is **no longer a scoping question** — the machinery is fully built as of R-242. What's left there is a human step (an owner or attorney actually using `/jurisdiction` and `/screening-criteria` on the real seeded TX rule and v1 criteria), not a backlog row.

**Carried defects (unowned, still true):**
- No GUARANTOR notification-preferences screen exists at all (D-252), though GUARANTOR is a real audience for `rent_reminder`, `payment_plan`, `lease_signature`, `account_access`.
- `plan-esign.ts` hardcodes TENANT for a payment-plan signature invite even though a `LeaseSigner` could in principle be a guarantor.
- `/money/deposits` has never shown a batch in the demo — needs a real open Stripe invoice or a simulator run.
- Demo seed writes a future `moveOutAt` on two ACTIVE leases, a state the product cannot produce (harmless today).
- Unserved entry notice + later hand service does not re-judge the window; needs counsel on damages for entries already made (R-228).
- `payment-plan-job.ts` / suppressed-fee report gap (R-227).
- No MTM rollover rate cap, no withdrawn-increase tenant message, R-223-R-233 migrations not on the Neon dev branch (R-225).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`.
- **The vitest suite has no shared `uniqueStateCode()`-equivalent helper.** Every job/unit test file that needs a `JurisdictionRule` picks its own hardcoded 2-letter state code and tracks collisions by a manually maintained comment list (TX/ZZ/XY/ZY/XW/NY/YQ, and until R-239, QZ). Not yet a real fix — worth one (a shared helper in a vitest test-utils module) only if a second file ever shows the same flake; none has.

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.
- **zsh also treats `status` as a read-only variable name** — name any Monitor/loop script variable something else (`run_status`, etc.).
- A CI e2e failure on notification-confirmation text during evening hours is very likely the quiet-hours issue R-237 already fixed for 5 files — if it recurs somewhere else, extend `safeTimeZone()`'s usage rather than re-diagnosing from scratch.
- **Never `vi.spyOn` a method on the shared `prisma` client singleton in a test** (R-238). Manually save/reassign/restore in a `try/finally` instead (see `apps/web/lib/jurisdiction/queries.test.ts`'s `rulesForConfigured` describe block).
- **A fixed literal used as a `JurisdictionRule.state` (or any nullable-jurisdiction fixture key) in a vitest integration test is not actually isolated** (R-239). Use a randomly generated state code (`uniqueStateCode()` in `e2e/fixtures.ts`), never a fixed literal.
- **A Prisma `findMany` with no tiebreaker in its `orderBy` is not actually deterministic when rows can tie on the sorted column** (R-239/R-240). Check for a secondary sort key before trusting an `orderBy` on a timestamp column a transaction could have written more than one row under.
- **`npm test`'s exit code is trustworthy as of R-239/R-240.**
- **A new permission in `packages/core/rbac/permissions.ts` needs `npm run db:seed:test` before a local e2e run against it will pass** (R-242, this session) — `Role` rows are data, not the code constant.

Everything older is in git history at `8417549:NEXT.md` (R-241's handoff) and earlier commits named in that file.
