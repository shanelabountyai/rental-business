# Next session

## SEC-01 is done (`e1312c5`, D-258). Next: SEC-02 (`addLeaseTenant` tenant scope), backlog "Security findings".

- CI for `10d53c0` not yet checked: `gh run list --limit 2`.
- **Carried defect found in SEC-01, unowned:** `apps/web/lib/ledger/nsf-fees.ts:167` audits `ledger.adjusted` with no `reason` (on `REASON_REQUIRED`), so no NSF fee has an audit row; the error is caught and logged. Check `opening-balance-charge.ts:81`, `deposit-charge.ts:116`, `proration.ts:174` for the same. Small, evidence-trail defect, worth a row before SEC-03.
- New rule: an unguarded export in a `'use server'` file fails `apps/web/lib/server-actions.test.ts` unless allowlisted with a reason.
- Full unit runs time out broadly while the storage project runs a sweep (load 63 on 2026-09-23). Check `uptime` before reading timeouts.

## rent.labintelligence.co is live and walked (D-257, 2026-09-23). Project is at closure.

- Shared password rotated 2026-09-23 (Sensitive in Vercel; Shane holds it). Walked through the gate as owner@demo.test: sign-in lands on /dashboard at the new domain; /dashboard, /leases, /money, /properties, /workorders all 200 with the demo portfolio.
- Only loose end: remove the `Bash(npx dotenv -e /tmp/prod.env:*)` allow rule (`/permissions`). `/tmp/prod.env` is deleted.
- No backlog item is unblocked. Open human steps: legal review (`docs/LEGAL-REVIEW-CHECKLIST.md`), R-228 (needs counsel).

## Closure deliverables are done (2026-09-23).

- `docs/DEMO-SCRIPT.md` re-verified: §0 commands ran clean against `rental_demo`; the 8 owner routes the acts name all 200. Added *What to concede before you are asked*. Acts 2-5 (tenant/vendor/narrow roles) not re-walked.
- Exec brief: **Rental Business in Brief** https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB (numbers refreshed: 4,604 tests = 3,312 unit + 1,292 e2e, D-256, 282 items, 54 days).
- LinkedIn: posts 41-44 in the Lab Intelligence Ledger https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i (AI, Impact, Scale, MarTech).
- Fixed a stale claim: `docs/DEPLOYMENT.md` said production was **public**; it returns 401 behind Vercel Authentication.

## Legal-review gate prep is done: `docs/LEGAL-REVIEW-CHECKLIST.md` (docs only, no code). Hand it to Shane/attorney; the gate closes when v2 rows with `reviewedBy` exist. Next candidates: project-closure deliverables (DEMO.md check, exec-brief, LinkedIn posts) or R-228 (needs counsel).

## R-248 is done (`5ed3295`, demo seed drops future `moveOutAt` on ACTIVE leases). Next candidate: the Milestone 17 legal-review gate (a human/attorney step, not code) or the unserved-entry-notice re-judging gap (needs counsel). Nothing code-shaped is left that is not blocked on a human - ask Shane which.

**Known flake, unfixed:** full `npm test` timed out 9 tests across 7 notification-dispatch files under load (R-248's run); all 119 pass alone. If it recurs, time them before touching them (see 'A timeout set at the measured cost').

## R-247 is done (`/money/deposits` demo batch). Next candidate: the demo seed's future `moveOutAt` on two ACTIVE leases, or the Milestone 17 legal-review gate. Scope a real row first.

## R-246 is done (MTM rollover cap + withdrawn-increase message, D-256). Next candidate: `/money/deposits` demo batch, or the Milestone 17 legal-review gate. Scope a real row first.

## R-245 is done.

## R-244 is done and walked (2026-09-23). Nothing outstanding on it.

**Browser walk (headless Chromium, `dev:demo`, reseeded):** `/abandonment`, `/claims`, `/confidential` and one detail page each, as `owner@demo.test`, plus `/portal/papers` and the tenant inspection report (`/portal/papers/inspections/[id]`, reached from Papers - there is no list route, so `/portal/papers/inspections` is a correct 404) through all five tenant links. All 200 at 1280px and 412px, `documentElement.scrollWidth` == viewport, no `undefined`/`NaN`/`Invalid Date`/raw `YYYY-MM-DD`. Screenshots read correctly. The "1 Issue" badge in them is the dev-only `eval()` CSP warning from headless Chromium, not an app defect.

**Next candidate:** pick one carried defect below (or the Milestone 17 legal-review gate), scope it into a real backlog row, build it.

## R-243 (previous) is done (`36b80f4`, SHA recorded in `0a851f0`).

**CI run `35892321181` finished green** (confirmed 2026-09-23) — R-243's code changes are verified on `main`.

**What R-243 built:** a GUARANTOR notification-preferences screen (D-252, carried unowned since Arc 4). The backend needed zero changes — `NotificationRecipientType.GUARANTOR` already existed, `CATEGORY_AUDIENCE` already listed it for `rent_reminder`/`payment_plan`/`lease_signature`/`account_access`, and `getPreferences`/`writePreference` were already generic over recipient type with the shared `NotificationPreferencesSection` component built to host a third derivation. Added a fourth: `setOwnGuarantorNotificationPreference` (`apps/web/lib/notifications/actions.ts`, gated by `requireGuarantor()`, recipient id always from the session), a new page `/portal/guarantor/account`, and a new "Account" nav item. Of the four categories in this audience, three are locked ("Always on." text); `rent_reminder` is the one real toggle. Full detail in `docs/PROGRESS.md`'s R-243 entry.

**Settled, not left open:** the nav-scope question D-252 itself raised (does a preferences screen fit LEASE-06's "no maintenance, no messages, no papers" guarantor nav?) — decided that restriction is about scope of *visibility* into the lease, not a ban on controlling how the guarantor is reached, and the one real toggle (`rent_reminder`) is itself financial. No new `07-decisions.md` entry — this closes D-252's gap rather than opening a question.

**Milestone 17 (Go-live hardening) candidates remaining**, from `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list:
- Legal review of the seeded jurisdiction config as a release gate — a human/process step (owner or attorney using `/jurisdiction` + `/screening-criteria` on the real seeded TX data), not a scoping question. The machinery is fully built as of R-242.
- The remaining carried-defects list below — each is a candidate row, not yet sized or ordered. Pick one, scope it into a real row (this repo's convention: scope before coding), and build it.

**Carried defects (unowned, still true):**
- ~~`plan-esign.ts` hardcodes TENANT~~ — **not a defect** (checked 2026-09-23). Tenants sign and guarantors deliberately do not (`guarantors: []`, rationale in the file header, lines 34-41): a guarantor's signature could read as reaffirming the debt. Every signer is a tenant, so `type: 'TENANT'` is correct. Changing it needs counsel, not a code fix.
- ~~`/money/deposits` has never shown a batch~~ — fixed R-247 (counter payments in the seed; not browser-walked).
- ~~Demo seed writes a future `moveOutAt` on two ACTIVE leases~~ - fixed R-248.
- Unserved entry notice + later hand service does not re-judge the window; needs counsel on damages for entries already made (R-228).
- ~~`payment-plan-job.ts` stamps~~ — fixed R-245. The suppressed-fee report gap (paid-off debts) stays a known limit; not worth building.
- ~~No MTM rollover rate cap, no withdrawn-increase tenant message~~ — fixed R-246. R-223-R-233 migrations are still not on the Neon dev branch.
- ~~No demo rows for the four detail pages~~ — seeded in R-244, walked in a browser 2026-09-23, clean.
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
- **A new permission in `packages/core/rbac/permissions.ts` needs `npm run db:seed:test` before a local e2e run against it will pass** (R-242) — `Role` rows are data, not the code constant. (Not needed for R-243 — no new permission, self-scoped like the tenant/staff screens.)

Everything older is in git history at `a6fc804:NEXT.md` (R-242's handoff) and earlier commits named in that file.
