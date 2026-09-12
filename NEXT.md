# Next session

## R-203 is done — the payment plan's e-sign half (D-214, D-218/219/220).

Code `6770095`, SHA commit `7499b45`.
**CI run `34712140082` — read the result on the run yourself before quoting
it.** It was still in flight when this file was written; the session that
wrote it armed `gh run watch` and recorded the outcome in `docs/PROGRESS.md`.
If PROGRESS does not state a colour for that run, **nobody read it** — three
seconds of `gh run list --limit 5` settles it.

**Do not copy a CI line forward to your own item.** `gh run list --commit`
only matches a FULL sha and returns EMPTY for a short one, with no error;
that empty result is indistinguishable from "docs-only push, no run". Use
`git rev-parse <short>` first, or watch by id.

## Start here: row 191, the next ⬜ in Milestone 14 ("Arc 4")

`docs/prds/06-backlog.md`. **Re-verify the row's premises first (R-150)** —
R-201 found two of four cited sites already fixed, R-202 found the row's
stated *cause* wrong while its class held, and R-203 found all five of the
queries R-090's comment warns about already correctly scoped. The row is a
hypothesis, not a finding.

## What R-203 changed, and the trap it caught

- **`LeaseEnvelopeKind` has a THIRD value, `PAYMENT_PLAN`.** Working
  CLAUDE.md's "adding a value to a status enum is never one edit" is what
  found the only real defect in the item: `esign-actions.ts` branched
  `AMENDMENT` or `else`, and `completeEnvelope`'s own `kind !== 'LEASE'` belt
  would have swallowed a completed plan **in silence** — every signer signs,
  nothing archived, no error. It is a `switch` on all three kinds now, and
  **a fourth kind must add a case there.**
- **MEASURED against the reverted fix (D-197):** red in 4 of 4 runs (both
  projects, both attempts), reading `SENT` where `COMPLETED` was expected.
- **`archiveExecutedDocument` in `apps/web/lib/leases/executed-pdf.ts`** is
  now the ONE copy of "draft bytes + completion certificate → archived PDF".
  It existed twice (lease, amendment) and this would have made three. All
  three call it; they differ only in the file name.
- **`SignForm` takes a `what` prop** and every sentence on `/sign/[token]`
  reads `signedThing(kind)` in `sign-link.ts`. The amendment's button now
  says "Sign this change to the lease" — `lease-party-change.spec.ts` was
  updated for it. A fourth kind adds a case to `signedThing` and nothing else.

## Owned by nobody, from R-203

- **No staff withdraw for a signing request.** A plan out for signature
  refuses a second send; ending the plan and agreeing a new one is the stated
  path and voids the envelope on the way out. Nobody has asked for
  withdraw-and-resend.
- **The demo seed creates no payment plan at all**, so a D-28 walk can see
  neither R-199's schedule nor R-203's signature. Predates this item.
- **`LeaseSignerStatus.DECLINED` is written by nothing**, for any kind of
  envelope — the sign page offers sign or leave, as R-063 built it.
- **Nothing tells staff a sent agreement has gone unsigned for weeks**, and
  deliberately (D-220): the plan is in force either way, so an unsigned one is
  not an outstanding task.
- **`plans.ts`'s `PLAN_SELECT` now joins the envelope and its signers** for
  every caller, `activePlansByLease` included — the rent roll and the nightly
  sweeps pay for a join they did not before. One plan per tenancy, so it was
  not worth a second query shape; noted in case it ever shows up.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is nine-plus migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and now including
`20260907120000_r175_payment_plans` and
`20260912120000_r203_payment_plan_esign`, so it has no `PaymentPlan` table at
all. `npm run dev` reads `.env.local`, so a walk against the dev branch would
500 on anything built since R-165. **`npm run db:migrate:dev` is the whole
fix; it has still not been run**, and R-203 has now widened what it blocks.
(R-203 itself did not need it — `npm run dev:demo` and the test database are
both local.)

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Binding for every row in this arc

The review's **"do not build"** list, repeated in the Milestone 14 header and
D-201: no accrual or interest engine before a second state; no Stripe
Connect; no settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
`TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds; **no second
queue** (D-9); **no backfill of anything**; no per-stage turn table, no second
definition of "days vacant".

## Still true from earlier handoffs

- **Rows 81 (R-081), 97 (R-097) and 155 (R-168) are SPLIT-PARENT
  placeholders.** Every child shipped. Ticking them is bookkeeping.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-203's `npm test` was **3172 passed in ~40s**, so the machine was clean this
session. If a run comes back at 190s+ with `Hook timed out in 10000ms` in
files the item never touched, that is contention, not a regression. Settle it
in this order — it is faster than a stack trace:

1. `psql -c "select count(*) from pg_stat_activity"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → no file for the
   relevant minute means the OS killed nothing. `Killed: 9` names no culprit.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** A file taking ~188s and still PASSING is
   this symptom's tell.
6. `ps` → idle Playwright `test-server` daemons from sibling projects.

**Sibling daemons are not this repo's to kill** — scope every kill to `$PWD`.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197) — the second kind hides from an
element-by-element probe; only `document.documentElement.scrollWidth` sees it.
R-203 did both and was green.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`.** Both give a wall of instant failures with no
`DATABASE_URL`, which reads exactly like the jetsam symptom and is not it.
(`--list` is safe without it, and is how you get the real expected e2e count.)

**Prove a new assertion against the reverted fix** (D-197). R-202 and R-203
both did, and both times it changed what the entry could honestly claim.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-203's ran clean in ~30s and
is the only check that sees a hand-written migration applied to an empty
database.

**A seed defect is only visible on a walk** (D-28).

## Leftovers still owned by nobody

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by
no test; slips and notices already issued keep the raw date in stored text
(forward-only, D-201); the demo seed creates no deposit batch and records no
SCRA termination. `consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not
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
