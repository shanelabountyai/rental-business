# Next session

## R-204 is done — the Arc 4 demo walk (D-28), and its eight defects.

Code `14c7be8`, SHA commit `08b8134`. **CI run `34726068479` was still
running when this was written — CHECK IT, do not copy this line forward.**
`gh run view 34726068479` settles it in three seconds.

`gh run list --commit` only matches a FULL sha and returns EMPTY for a short
one, with no error — indistinguishable from "docs-only push, no run". Use
`git rev-parse <short>` first.

## THE BACKLOG IS EXHAUSTED. There is no next row.

Rows 1–191 are all ✅ except: **28** (⏸️ paused to Phase 3), **48/95/96** (❌
cut), **93** (externally blocked — real vendor drivers, each needing a signed
commercial relationship; not a laptop item), **81 / 97 / 155** (split-parent
placeholders). R-204 was row 191, added this session.

**Rows 81 and 155 are pure bookkeeping and can be ticked ✅ without work** —
81's four children (R-081a/b/c/d) and 155's R-168 + R-168a all shipped.
**Row 97 is NOT** — `97b` (rent credit-bureau reporting) is vendor-gated like
93, so the parent is genuinely open.

## The decision this session did not make

Arc 4 closed at R-203 and the walk is its D-28 checkpoint. **What sources
Arc 5 is the owner's call**, and the precedent is three for three (D-164,
D-172, D-201): the **rental-operator agent** reviews the shipped product end
to end — PRDs, D-1…D-221, `PROGRESS.md`, this file's leftover list and the
code — and returns ~15 ranked findings that become Milestone 15, wrongness
first. Reviews are kept verbatim in `docs/reviews/`. The owner was offered
that, this walk, the bookkeeping, and "declare the project done", and picked
the walk. **The other three are still open.**

A review sourced this way **cannot see what only a browser shows** — R-204's
eight defects were all invisible to the test suite, and the packet one was
invisible to every screen as well. Worth saying to whoever writes Arc 5.

## What R-204 changed, and the trap worth carrying

- **`friendlyDate(instant, zone)` is the display reader; `businessDate` is
  the logic one.** Same argument list, so the fix was a one-token swap at
  ~20 call sites. The separation is clean and mechanical: **every display
  site passes a stored field, every logic site passes `new Date()`**. That
  predicate is how the sweep was made safe, and it is how to re-run it.
- **A structured object passed through whole is how the exception gets in**
  (D-221). `PacketFacts` takes a pre-formatted string for all seven of its
  dates *except* `clock`, a typed `CureClock` carrying two raw
  `BusinessDate`s — so the eviction packet PDF printed `Last day to cure:
  2026-09-09` while **both screens showing the same two values already
  called `friendlyBusinessDate`**. Nothing was red. Nothing looked wrong.
- **The tell is always a right-looking neighbour.** `fee.dueOn` formatted on
  the line directly above `fee.waivedAt`, which was not. `{request.kind}`
  raw beside a correctly-wrapped `friendlyBusinessDate(request.receivedOn)`.
  `{inspection.type}` raw beside `INSPECTION_STATUS_LABELS[status]`.
- **`INSPECTION_TYPE_LABELS` is new.** A seventh `InspectionType` value must
  add a case there, and to nothing else.
- **A test can pin half a defect in place.** `e2e/inspections.spec.ts:285`
  asserted `'MOVE_IN · Pending signature'` — the status half already going
  through its label map, the type half not. It was the only assertion in the
  suite that broke, on both projects, which is the right outcome.

## The crawl scripts are gone, deliberately

Two throwaway Playwright scripts (staff BFS from `/dashboard`; portal from
each magic link) wrote page text + `documentElement.scrollWidth` to JSON,
then the corpus was grepped for `YYYY-MM-DD`, SCREAMING_ENUM, `undefined`,
`NaN`, `Invalid Date`, `[object Object]`. **~60 lines each, and worth
rewriting rather than keeping** — R-105 and R-184 each wrote their own, and a
committed crawler is a thing to maintain for three uses a year. Two gotchas
if you write the third: a script outside the repo root cannot resolve
`@playwright/test`, and `/workorders/[id]/timeline` is a download, so
`page.goto` throws "Download is starting" rather than returning a response.

## Owned by nobody, from R-204

- **The seed's type vocabulary is guarded by nothing.** `ComplianceItem.type`
  is free-form by design, so `COMPLIANCE_ITEM_TYPES` is a *form* vocabulary,
  not a constraint — a seed literal outside it is invisible until somebody
  looks at the screen. R-195 recorded the same shape for Task subject strings
  and **both are still true**. A test needs the seed's tables exported, which
  is scaffolding; the walk is the check.
- **Demo rows already written keep their old values.** The three compliance
  rows were updated in place to verify the fix; a service note already stored
  keeps its raw date until a `--reset`. Forward-only, exactly as R-201's
  deposit slips and SCRA notices are.
- **`esign-panel.tsx` declares `sentAt`, `completedAt`, `voidedAt` and
  renders none of them.** Formatted along with the rest rather than left as
  the next defect, but a prop nothing displays is a question.
- **Five public token surfaces went unwalked** — bid, apply, prescreen,
  showing, pay. `db:seed:demo-access` prints only the vendor *job* link.
  R-184 covered all of them.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is ten-plus migrations behind**, back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table
at all. `npm run dev` reads `.env.local`, so a walk against the dev branch
would 500 on anything built since R-165. **`npm run db:migrate:dev` is the
whole fix; it has still not been run.** (R-204 did not need it — the demo
database is local, and `db:migrate:demo` applied five pending migrations to
it at the start of this session.)

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197). **Locally `npm run test:e2e` runs BOTH
projects already** — R-204's 160-test run was 80 per project, so `--list` is
how you get the real expected number.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`.** Both give a wall of instant failures with no
`DATABASE_URL`, which reads exactly like the jetsam symptom and is not it.
(`--list` is safe without it.)

**Prove a new assertion against the reverted fix** (D-197). R-202, R-203 and
R-204 all did.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-204 had no schema change,
so it did not apply.

**A seed defect is only visible on a walk** (D-28) — two of R-204's eight.

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-204's `npm test` was **3,173 passed in 14.9s**, so the machine was clean.
If a run comes back at 190s+ with `Hook timed out in 10000ms` in files the
item never touched, that is contention, not a regression:

1. `psql -c "select count(*) from pg_stat_activity"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → no file for the
   relevant minute means the OS killed nothing. `Killed: 9` names no culprit.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** A file taking ~188s and still PASSING is
   this symptom's tell.

**Sibling daemons are not this repo's to kill** — scope every kill to `$PWD`.

## Leftovers still owned by nobody

From R-203: no staff withdraw for a signing request; the demo seed creates no
payment plan, so a walk can see neither R-199's schedule nor R-203's
signature; `LeaseSignerStatus.DECLINED` is written by nothing; nothing tells
staff a sent agreement has gone unsigned (deliberate, D-220); `PLAN_SELECT`
now joins the envelope for every caller.

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by
no test; the demo seed creates no deposit batch and records no SCRA
termination. `consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not
"fix" it**; `friendlyBusinessDate` throws on `friendlyTimestamp` output.

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state; the demo seed configures
Texas only.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went; the guarantor portal does
not show the plan.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report; a late-delivered payment in an already-swept range belongs
to no recorded transfer.

From R-196: `sendReminders` reports "sent to N people" even when every channel
was suppressed; a phone-only guarantor cannot enter their portal.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end;
`demo-seed.mts` writes Task subject strings outside the union.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none, so every house reads "No property tax or insurance booked".

From R-183: no accrual engine, no interest rate on `JurisdictionRule`;
`Deposit.escrowAccountRef` / `interestAccruedCents` are written by nothing.

From R-173: a tenant with a phone but no email still gets a live PORTAL row
and cannot sign in.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
