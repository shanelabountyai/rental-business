# Next session

## R-208 is done. Pick up R-209 — the deposit applied to arrears that never reaches the ledger.

R-208 shipped as `d7b3105` (SHA recorded in `b4c534a`). **CI run
`35009495087`** — read it on the run itself, `gh run view 35009495087`.
**Do not copy a CI line forward**; that error cost eleven items (R-130–R-140).

**`gh run list --commit d7b3105` returns EMPTY and the pipeline is fine.**
Both commits went up in one push, so the run is attributed to the HEAD sha
(`b4c534a`, the docs-only one) and the code commit matches nothing. Combined
with R-207's two traps — `--commit` matches only a FULL sha, and
`paths-ignore: ['**.md', 'docs/**']` means a docs-only PUSH legitimately has
no run at all — that is three separate ways to read a green pipeline as dead.
`gh run list --limit 5` and look at the titles is the check that does not lie.

**Start here:** `docs/prds/06-backlog.md` → row 196 / **R-209**. The review is
verbatim at `docs/reviews/2026-09-13-operator-review.md`; D-222 holds the
binding "do not build" list.

## R-209, concretely

`computeDisposition` sets `appliedCents = min(heldCents, deductions +
outstandingLedgerCents)` (`packages/core/ledger/disposition.ts:52-56`) and
`finalizeDisposition` writes that number onto the `Deposit` row and into the
letter (`apps/web/lib/deposits/actions.ts:284-292`) — and writes **no ledger
entry at all**. A grep for a credit posting on the disposition path returns
nothing. So the letter says the deposit settled the arrears and the tenancy
still shows the whole balance.

**Re-verify it before touching anything.** R-205, R-206, R-207 and R-208 all
re-verified an inherited finding and all four were correct as written —
R-208's line numbers matched exactly. That is four for four, which is a
reason to keep checking, not to stop.

**`LedgerEntry` is append-only and Stripe is the system of record** (D-11).
The projection is built from webhooks, so a credit written straight into it is
a row Stripe does not know about — which CLAUDE.md calls a reconciliation bug
in so many words. Work out what R-209's credit actually IS before writing it:
an adjustment, a Stripe credit note, or a reversing entry. **This is the
single hardest constraint on the row and it is not mentioned in the review.**

**Never backfill** (D-201, D-222). Report the history, fix the writer, leave
reconciled rows alone. R-208 obeyed it by construction: an already-active
lease emits no `lease.activated`, so it gets no move-in report.

## What R-208 left behind

- **A renewal successor still has no `MOVE_IN` report under its own
  `leaseId`.** R-208 excludes `origin: 'RENEWAL'` deliberately and correctly —
  nobody moves in on a renewal — but `itemsFromMoveIn` keys on
  `{ leaseId, type: 'MOVE_IN' }`, so a move-out comparison on a renewed
  tenancy has nothing on the left and falls back to a template.
  `endRenewalPredecessor` re-points the `Deposit` rows at the successor and
  nothing re-points or cross-reads the condition report, so a tenant who
  renewed twice needs a baseline two leases back and gets none. **The fix is
  for `move-out-copy.ts` to walk `renewedFromLeaseId`, NOT for activation to
  manufacture a second baseline.** Owned by nobody; **R-218's deposit-dispute
  packet is the item that will feel it first**, and R-218 already depends on
  R-208.
- **`defaultForType` is globally UNIQUE, so the portfolio has exactly one
  move-in checklist.** Right at 10–50 doors, wrong for a portfolio mixing a
  studio with a four-bedroom. A per-property default is the next step and is
  not built.
- **The access-code warning cannot fire for a lease with no cash deposit.**
  `deposit-clearing-job.ts` selects `depositArrangement: 'CASH', depositCents:
  { gt: 0 }`, so a surety-bond or no-deposit tenancy gets neither the Task nor
  the warning — the codes are released by some other route and nothing checks
  for a walk. Owned by nobody.
- **No e2e drives the consumer, deliberately.** `defaultForType` is globally
  unique, so a spec designating a MOVE_IN default changes lease-activation
  behaviour for **every concurrently running spec** — the magic-fixture-value
  trap, and the shape that broke `leases.spec.ts`'s `afterAll` in R-202.
  `rental_test` has no MOVE_IN default template, so no existing spec changed.
- **The demo seed writes its leases straight to ACTIVE and emits no
  `lease.activated`**, so nothing in the demo exercises the consumer. The new
  `Move-in condition walk` checklist shows the configuration it needs, not the
  behaviour. **R-220's demo walk** is where that gets seen.

## Two traps R-208 paid for, worth reading before the next item

**A `SetNull` cascade onto an append-only table is an UPDATE, and the delete
fails on the WRONG TABLE.** The consumer test's `afterEach` deleted its own
`OutboxEvent` rows the way `delist.test.ts` does, and every test in the file
went red on `Notification is append-only; UPDATE is not permitted` —
`Notification.eventId` points at `OutboxEvent` with `SetNull`. Third instance
of CLAUDE.md's first append-only consequence, and the one that hides best: the
error names `Notification` while the failing call is `outboxEvent.deleteMany`.
Leave the rows standing and retire the property instead.

**A `<select>` option label is a page-width decision.** R-208's new option is
38 characters against the existing longest option's 40, with the reason
written above the list. D-194: a native select's min-content width is its
widest option, and R-182 put 930px inside a 412px viewport that way.

## MACHINE CONTENTION — R-208 hit it, and the diagnosis inverted

R-208's first `npm test` came back **100+ failures across a dozen files it
never opened**, all `Hook timed out in 10000ms`, and **exit 137**. It was
jetsam: **four `JetsamEvent-2026-09-15-13*.ips` files at 13:32, 13:33, 13:37
and 13:43**, while a sibling project (`Restaurant ordering`) had a full vitest
sweep resident and `kern.memorystatus_level` had fallen to 26%.

**Note the inversion.** The usual use of that check is that NO file means the
OS killed nothing; here the files' PRESENCE is what settled it. Check the
timestamps against the minutes the run was dying, not just whether files
exist — the machine accumulates them.

The clean re-run was **3,199 passed / 4 skipped** in 42s. The checks, in
order:

1. `psql -d postgres -c "select datname, count(*) from pg_stat_activity group by datname"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → match the MINUTE.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** A file taking ~188s and still PASSING is this symptom's tell.

**Sibling sweeps are not this repo's to kill** — scope every kill to `$PWD`.
R-208 queued its own run behind the neighbour's rather than killing it.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197). Locally `npm run test:e2e` runs BOTH
already, so `--list` is how you get the real expected number — **1,240 tests
in 100 files** as of R-208.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`** (`--list` is safe without it). And in **zsh an
unquoted `$F` does not word-split** — spell the paths out.

**Prove a new assertion against the reverted fix** (D-197). R-202 through
R-208 all did; R-208's revert took 5 of 13 red, the 3 green ones being
negative cases that assert absence and structurally cannot go red.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-208 needed none — its only
schema edit was a `///` doc comment, which produces no SQL; `prisma validate`
with the env loaded is what confirms such an edit still parses (bare
`prisma validate` fails on a missing `DIRECT_URL` and tells you nothing).
**R-217 (`habitabilityRepairDays` on `JurisdictionRule`) does need it.**

**A `'use server'` module may export only async functions, including a type
re-export.** `npm run build` is the only check that catches it.

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.**
  Findings 1, 2 and 3 were spot-checked during planning; the rest are
  inherited evidence. Four for four correct so far.
- **Never backfill.** D-201 already paid for this lesson.
- **Two rows still Needs counsel** (R-213, R-217); R-208's counsel question —
  the penalty exposure of a missing move-in report — is now a live question
  about a gap that is closed going forward, not a blocker.
- **D-222's "do not build" list is binding**: no Stripe Connect, no
  house-rules settings screen, no second queue (D-9), no deposit interest
  engine, no `businessDaysBetween` rewrite.

## What the review structurally could not see

**Anything only a browser shows.** It read code and schema. **R-220 is the
Arc 5 demo walk** and it owes the five public token surfaces R-204 left
unwalked — bid, apply, prescreen, showing, pay; `db:seed:demo-access` prints
only the vendor job link. It now also owes the new `Move-in condition walk`
checklist screen.

**Anything gated on a real vendor API.** Screening, e-sign and credit
reporting run against simulated adapters (PRD 00 §14, D-7/D-27). R-093 and
R-097b stay vendor-gated.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is ten-plus migrations behind**, back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table.
`npm run dev` reads `.env.local`, so a walk against it would 500 on anything
built since R-165. **`npm run db:migrate:dev` is the whole fix; it has still
not been run.** It writes to a cloud database, which is why no session has
done it unasked.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Leftovers still owned by nobody

From R-207: `urgent` does not reach `scheduleRetry`, so a bounced emergency is
still retried at 08:00 (needs a `Notification` column plus a migration; the
comment at `scheduleRetry` names it); `plan-actions.ts:258` counts a DEFERRED
outcome as "on its way" (R-211 owns the neighbouring `sendReminders`
version); the bid-request send in `approvals.ts` sets no `urgent` and still
defers, deliberately; no e2e drives `dispatchToVendor`'s notice.

From R-206: the chase ladder fires once per arrears EPISODE, not once per
unpaid period, recorded as D-224; `webhook.ts:296` can put fee money in an
unlinked `CHARGE` entry when `fits = linkedTotal <= movedCents` is false
(understating, the safe half); a balance moved by an `ADJUSTMENT` with no
charge behind it still falls through to the oldest known debt (deliberate);
`late-fees.ts` pass 2 deliberately does not use `rentDebtsFor`.

From R-205: pass 2 reads every active lease in the property, so
`leasesChecked` counts more than it did and a held lease can be counted in
`heldLeases` by both passes; a `LATE_FEE` raised by pass 1 earlier in the same
run is in pass 2's debt list before it is in the balance.

From R-204: the seed's type vocabulary is guarded by nothing; demo rows keep
their old raw dates until a `--reset`; `esign-panel.tsx` declares `sentAt`,
`completedAt`, `voidedAt` and renders none.

From R-203: no staff withdraw for a signing request; the demo seed creates no
payment plan; `LeaseSignerStatus.DECLINED` is written by nothing.

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by
no test. `consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not "fix"
it**; `friendlyBusinessDate` throws on `friendlyTimestamp` output.

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report.

From R-196: `sendReminders` reports "sent to N people" even when every channel
was suppressed — **now R-211**; a phone-only guarantor cannot enter their
portal — **now R-216**.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`.
**D-222 keeps this out of scope.**

From R-173: a tenant with a phone but no email still gets a live PORTAL row
and cannot sign in — **now R-216, and R-210 is the `Notice` half**.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
