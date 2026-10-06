# Next session

**2026-10-05 (later): MONEY-13 fixed (D-290).** SHA and gate in `docs/PROGRESS.md`. Queue row 1 is done; a bare `go` picks up **row 2: MONEY-14 + MONEY-16 + TEST-01** (Opus). Shane's three steps below are still owed and unchanged — nothing in MONEY-13 adds a migration, so the D-289 one is still the only pending one.

**2026-10-05 (night): MONEY-11 + MONEY-12 fixed (D-289), MONEY-15 comment, SEC-21 repo side.** SHA and gate in `docs/PROGRESS.md`. The list below is the earlier session's; items 1 and 3 are updated here.

## Owed by Shane, in this order

1. **Apply migration `20261005120000_money11_split_pushed_at` to production** (`docs/DEPLOYMENT.md` neonctl / `prisma migrate deploy` recipe). The new code reads `pushedAt`; deploying first breaks every portal payment.
2. **POST the `main-manual` deploy hook once** (or click Deploy in Vercel). That one build ships this fix and the three queued env rotations (Blob token, Stripe test keys, `DEMO_ACCESS_PASSWORD`).
3. **Then regenerate the hook** (SEC-21). The old URL is out of D-277 at HEAD but is in public history at `bf30ca7` and works until regenerated. Keep the new one out of the repo.

## Next buildable item

~~MONEY-13~~ done (D-290). **MONEY-14 + MONEY-16 + TEST-01** next (queue row 2), Opus.

Also still owed: eyeball `/portal/pay/history` and `/portal/guarantor` at phone width in `dev:demo`; commit the storage repo's convention port (item 5 below).

---

**2026-10-05 (late): post-closure review — run queue.** Reconciled after the "night" session above landed MONEY-11/12/15 (D-289) and the D-277 edit. Shane's three steps above come first; then a bare `go` runs this, top to bottom. The same queue is the last section of `docs/prds/06-backlog.md`.

## Queue (one session each) — model in brackets; **Fable** = the review session's own recommendation for work where the cost of a wrong answer is high

1. ~~**MONEY-13**~~ ✅ done 2026-10-05 (D-290) — refund gets the dispute's invoice fallback (`findInvoiceForPaymentIntent`); refund→lost-dispute test on a card-autopay row. [**Fable** — it crosses three event paths (refund, dispute, invoice fallback) and the night session's D-289 shows the backlog's stated fix can be wrong; Opus acceptable]
2. **MONEY-14 + MONEY-16 + TEST-01** — partial-dispute cap; per-lease serialisation of `planAllocation` or a recorded decision not to; `renewal-rollover-job.test.ts` state code. [Opus; the MONEY-16 serialise-or-decline call is the one to think about]
3. **CLOSE-01** — regenerate `PRD.docx` (rendered 2026-08-01; 8 PRD commits since, latest 2026-09-18) or drop it from the closure deliverables in `WRITEUP.md`. [Sonnet]
4. **CLOSE-02** — pre-counsel citation table for the seeded TX `JurisdictionRule` → `docs/LEGAL-REVIEW-CHECKLIST.md` (MONEY-05 is row one). Prep for the human review, not legal advice. [**Fable**, with web search on — statute text must be quoted from the Texas Property Code as published, every row carries a confidence, and a confident wrong citation is worse than a blank; this is the row where model quality matters most]
5. **CLOSE-03** — by-topic index of `07-decisions.md` (289 D-numbers): money / jurisdiction / infra+deploy / tests / UX. [Sonnet]
6. **CLOSE-04** — Shane deletes `_to_delete/` (`BACKLOG.md`, `PRD.md`, `git-locks`, `rental-starter.zip`).
7. **CLOSE-05** — demo walk in a browser after 1–2 and the D-289 deploy (D-28: money-path changes), including the phone-width eyeball of `/portal/pay/history` and `/portal/guarantor` the night session asked for. [Opus; the walk finds things a test cannot — R-105 found seven]

Storage repo (`~/Projects/storage business`) has its own two-item queue at the top of its `NEXT.md`: commit the convention port [Sonnet], then the same adversarial money review on its Stripe path [**Fable** — this is the pass that found MONEY-11..16 here].

## Correction to the record

"No loose ends" (kept below for the record) was wrong in three places when written: the hook URL, the deploy mechanism (status line copied forward past D-277), and `staff.spec.ts`. Two Claude sessions worked this tree at once on 2026-10-05: the review session wrote only `NEXT.md` and `06-backlog.md`; the parallel Claude Code session committed `0a5c5fe`, `8f19e76` and their SHA follow-ups, consuming the review's rows as it went.

---


**PROJECT COMPLETE — marked by Shane 2026-10-05.** Backlog has nothing buildable (every open row is vendor-, counsel- or go-live-gated, D-15) and all four closure deliverables exist. A bare `go` has no item to pick up. No loose ends.

## Done 2026-10-05: project-closure pass (SHA in `docs/PROGRESS.md`, "Project-closure pass")

- **Demo script** (`docs/DEMO-SCRIPT.md`) re-verified in a browser: setup commands, owner sign-in, 15 routes. `rental_demo` was four migrations behind; `db:migrate:demo` first, always. `/money/deposits` is MFA-gated (`ledger.adjust`), now noted in the script.
- **Exec brief** republished at the same URL with measured numbers: https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB
- **`WRITEUP.md`** synced (repo public, live URL, 287 decisions, 118 migrations, 3,479 + 1,310 tests, two new *Defects Found* bullets).
- **Cost review**: D-286 baseline, D-277 auto-deploy off. Nothing new left running.
- **LinkedIn**: ✅ done 2026-10-05. Posts 96-99 are in the Ledger (https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i), queued after 95 as 97, 96, 98, 99; `docs/LINKEDIN-DRAFTS.md` deleted. All four closure deliverables now exist.
  - **The Ledger's posts moved out of the page source into the artifact database the same day** (Shane's call), so an add no longer costs a ~195k-token read of a 541 KB page. The page is now ~54 KB and holds no posts.
  - **To add a post now:** `ArtifactData` `set` on collection `posts`, doc id = the post number, body `{n, project, pillar, hook, full, source, posted:false, date:null, image:null}`; then `get` `meta/queue` and `update` its `order` array (pin `if_version`). A post with no queue slot still shows, at the end. Do NOT republish the page to add a post.
  - The store was read back after the move (99 posts, queue of 99). The pre-migration page is version 65 in the artifact's history.
- ✅ **"Seventeen months" corrected 2026-10-05** to the measured span: 30 days and 168 backlog items (R-003 `62700de` 2026-08-01 to R-139 `80dac5a` 2026-08-31). Fixed in `WRITEUP.md`, `CLAUDE.md` and two code comments. No Ledger post and not the exec brief ever carried it.

## Prior: Done 2026-10-05: carried-forward test cleanup (`edaa0ef`, SHA backfill `ee69aa0`). Not a backlog row — see below for why.

**Backlog check first: `docs/prds/06-backlog.md` has nothing buildable this session.** Every remaining unchecked row (R-093, R-097-split, R-037a, R-097b, MONEY-05, OPS-01) is explicitly gated on a vendor contract, counsel, or a go-live decision — D-15 forbids simulating the vendor-gated ones. Shane chose to spend the session on the cheap carried-forward cleanup instead (see options below next time this comes up: project closure pass / cost-review baseline / stop and flag human-only items).

Closed 4 of the carried-forward items UX-07/UX-10 had been listing:
- `units.spec.ts` — `getByText('Down')` now `{ exact: true }`.
- `staff.spec.ts` — a11y test timeout raised 180s → 300s. **Caveat found while fixing it: isolated-alone measurement today is 3.8 minutes, not the old 45s/174s** — this machine's real cost for 3 axe scans has grown. 300s holds for a normal single-spec-file run; running it alongside `units.spec.ts` + `vendor-invoice-splits.spec.ts` together (not a realistic session, only done to batch-verify) pushed it past 300s on both tries. The real fix (split into one test per URL) is still not done.
- `vendor-invoice-splits.spec.ts` — `SetReserveForm`'s hint/error strict-mode collision was in the test's locator, not the component. Narrowed to the error's own wording.
- `comms.test.ts` + `pre-move-out-scheduling-job.test.ts` — **not just leftover data, a real self-reinforcing bug** in the second file: cleanup scoped by a collected-id list instead of unit ownership meant an untracked auto-scheduled inspection blocked `unit.deleteMany`, which threw *before* the `JurisdictionRule` cleanup line ran, leaking that test's rule every time it fired. Found **71 leaked rows** for this file's fixed `state: 'XW'` — fixed the cleanup scoping, deleted the leaked rows, replaced `comms.test.ts`'s 8 hardcoded phone literals with a local `uniquePhone()`. `npm test` now genuinely green (256 files / 3479 tests, 0 failures) — confirmed by rerunning `pre-move-out-scheduling-job.test.ts` twice more with zero new leaks.

Full detail, including the exact gate numbers, in `docs/PROGRESS.md`'s "Carried-forward test cleanup" entry.

## Prior: Done 2026-10-03: UX-10 (`8d92fef`, SHA backfill `1fef90f`). Dashboard tile and nav copy, plain language.

- Dashboard: "Aged delinquency" → "Rent overdue"; "Tenancies past grace" action item → "Late tenants"; "Emergency/urgent tickets" + its separate "Open past 48h" detail collapsed into one label, "Urgent repairs waiting over 2 days" (matches the backlog's acceptance text verbatim); Renewals tile's defensive "Mortgage & insurance dates, not statutory compliance" → "Upcoming mortgage & insurance renewal dates".
- `NavItem` gained an optional `subtitle?: string` (`lib/nav.ts`), rendered as a muted second line in `components/shell/nav.tsx`. Filled in only for the three terms the backlog row actually calls unexplained — Gone dark, Claims, Violations — not every nav item; the rest already read as plain English. Subtitle text pulled from each page's own `PageHeader` description so it doesn't introduce a second phrasing of the same thing.
- Deliberately untouched: "Open tickets" tile's own "{N} emergency/urgent open past 48h" detail (not one of the three named strings, and `dashboard.spec.ts:199` asserts it verbatim) and `rent-roll-table.tsx`'s per-row "past grace" status badge (same phrase, different location — a row status, not the dashboard tile this row is about; asserted across `rent-roll.spec.ts`/`golden-path-5.spec.ts`).
- Gate: lint/typecheck/build clean. `npm test`: first pass showed 63 unrelated failures from two SIBLING projects' (`storage business`, `adjuster`) own concurrent `vitest` sweeps exhausting the shared local Postgres connection ceiling — confirmed via `pg_stat_activity` (rental_test itself held 1 connection) and by rerunning clean once those sweeps finished: same 4 pre-existing unrelated failures `main` already carries. Scoped e2e: `dashboard.spec.ts` + `route-boundaries.spec.ts` 16/16, `shell.spec.ts` (covers the nav markup directly — both axe sweeps, phone-width overflow check) 26 passed + 1 flaky (resource-contention timeout, passed on retry) + 1 skipped = 28/28, both reconciled against `--list`.
- No schema change — `db:ci` not required.
- No demo-walk screenshot taken for this item — it's a LOW-priority copy pass with "design review sign-off; no automated acceptance" as its own acceptance line, and the e2e runs above already render and assert the real text. A full demo walk is reserved for milestone closes (D-28), not every backlog row. **Flag for Shane to eyeball the new copy/nav subtitles in the demo when convenient** — that's the "design review sign-off" this row asks for; nothing here should be read as having already gotten that sign-off.
- CI run should be queued on push (`1fef90f`) — **check `gh run list --limit 3` before trusting green.**

## Done 2026-10-05: the three carried-forward items (SHA in `docs/PROGRESS.md`, "Carried-forward cleanup 2")

- `staff.spec.ts` a11y test split per URL. The slowness was 17,779 leftover active legal entities in the access-scope select, now drained in the spec's `beforeAll`; scans are 2s.
- D-287: the two tenant statement tables are stacked cards on a phone (`components/portal/statement-table.tsx`); staff tables keep their scroll on purpose.
- D-288: `Panel variant="boxed"`, 25 exact-shape sections migrated; 39 small-heading boxed sections and all other boxed markup stay bespoke on purpose.
- **Owed:** eyeball `/portal/pay/history` and `/portal/guarantor` at phone width in `dev:demo`. Specs and axe pass on mobile-chrome; nobody has looked at the cards.
- This was a real code push, so the three queued env rotations below go live with its deployment **only if auto-deploy is on** (D-277 turned it off; check before assuming).

## Carried forward, unchanged:

- **OPS-01 still open, deliberately skipped** — go-live readiness list (no live Stripe key, $0 deposit on imported leases, no portal invite for imported tenants, simulated e-sign, daily-cron message delay). Revisit only when going live is actually planned.
- ✅ **DONE 2026-10-05: webhook endpoint created and live.** Turned out `we_1U47bfJ7dm36XvZPk4ekxGak` didn't exist at all — confirmed via `stripe webhook_endpoints list` against this project's actual test key, which returned zero endpoints. `docs/DEPLOYMENT.md`'s "set up and verified 2026-08-13" was stale; the orphaned `STRIPE_WEBHOOK_SECRET` in Vercel pointed at a deleted endpoint, meaning **no Stripe event had been reaching production at all**, not just the wrong dispute event. Created a new endpoint with the correct 10-event `HANDLED_EVENTS` list (`packages/core/billing/events.ts`), API version pinned to `2024-06-20` to match `stripe-adapter.ts:54`, new `STRIPE_WEBHOOK_SECRET` saved to Vercel Production, redeployed (`dpl` built clean from commits through `6f30621`) — confirmed Ready.
- ✅ **DONE 2026-10-05: production migrated.** `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both applied via the `docs/DEPLOYMENT.md` neonctl/`prisma migrate deploy` recipe. `migrate status` confirmed exactly these two pending beforehand, both additive (nullable columns, one enum value, a widened constraint); `migrate status` afterward: "Database schema is up to date!", all 118 migrations in sync.
- ✅ **DONE 2026-10-05: Blob storage token rotated**, found along the way (not one of the original four) — Vercel's env var screen flagged `BLOB_READ_WRITE_TOKEN` as a plaintext-visible Config var that should be Secret. Rotated via Vercel's native expiring-secret rotation UI on the Environment Variables screen (short expiration on the old value, not "never"). **The redeploy this needed got auto-skipped** (`ignoreCommand` correctly found a docs-only diff on `6f30621` and exited 0) — not broken, the new token just hasn't gone live yet and will the next time real (non-docs) code ships. Old token still valid under its grace period in the meantime.
- ✅ **DONE 2026-10-05: Stripe TEST secret key rolled.** The one a masking regex printed into the 2026-09-28 session transcript (test mode only, never sent anywhere). Rolled in Stripe dashboard, `.env.local:7-8,10` and Vercel Production's `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY` both updated by Shane directly (values never seen or echoed by Claude — file opened in the editor for him to paste into).
- ✅ **DONE 2026-10-05: `DEMO_ACCESS_PASSWORD` rotated in Vercel.** All four original human-only items from this session now closed. `demo-rental-2026` (the persona password in `seed-demo-access.mts:42`) deliberately NOT rotated — see D-285.
- **Three env rotations are queued behind the `ignoreCommand` skip, waiting on a real (non-docs) code push to go live:** `BLOB_READ_WRITE_TOKEN`, `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`, `DEMO_ACCESS_PASSWORD` — all saved in Vercel, none yet baked into a deployment. Confirmed twice today that an env-only or docs-only push gets `Canceled` (exit 0) rather than building. `STRIPE_WEBHOOK_SECRET` is the exception and is already live, because its redeploy happened to land on a commit with real code in it. Not urgent — Blob and Stripe key both have grace periods, and `DEMO_ACCESS_PASSWORD`'s old value simply stops being the gate once the new deployment ships, no exploit window either way. **Worth remembering next time any real code ships**, so these three aren't forgotten indefinitely.
- ✅ **DONE 2026-10-05: cost review baseline written into `07-decisions.md` as D-286** (Neon 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel build CPU $6.76 effective / $1.41 billed 09-01..09-26). No action attached — baseline only, compare future measurements against it.
- Legal review and R-228 still need a person (unchanged).
- **Backlog is still empty of buildable work** — every remaining unchecked row (R-093, R-097-split, R-037a, R-097b, MONEY-05, OPS-01) is vendor/counsel/go-live-gated (D-15). Closure pass is done bar the LinkedIn pick above. Next session: draft whichever angles Shane picked, otherwise wait for a vendor contract/go-live decision to unblock the gated rows.

## Prior: A11Y-01 through A11Y-11, UX-01 through UX-10 all done (see `06-backlog.md` and `PROGRESS.md` for each). 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Also done: SEC-17, MONEY-01/02/03/04/06/07/08/09/10, SEC-18, SEC-19, SEC-20, LEGAL-01/02/03/04/05.
