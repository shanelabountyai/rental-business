# Next session

## R-201 is done — the raw `YYYY-MM-DD` surfaces D-154's predicate cannot see (D-216).

SHA and CI run are recorded in PROGRESS. **Do not copy a green CI line
forward** — run `gh run list --limit 5` after your own push and read the run on
YOUR code commit. **A docs-only push has no run at all** (`paths-ignore` in
`ci.yml`), so if the SHA commit is pushed alone, do not wait for one.

**`gh run list --commit` only matches a FULL sha and returns EMPTY for a short
one** — no error, no warning. That empty result reads exactly like the
"docs-only push, no run" case above, so it will tell you nothing ran when
something did. Use `git rev-parse <short>` first, or skip the filter and watch
by run id: `gh run watch <id> --exit-status`.

## Start here: row 189, R-202

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"). **`e2e/leases.spec.ts`'s
cleanup stops flaking CI.** `prisma.unit.deleteMany()` refuses on
`WorkOrder_unitId_fkey` because R-178's lease-end opens work orders that race
the delete (recorded in R-179's own run). It costs CI time on every push. The
review declines it as a *product* defect and is right: it is spec hygiene with
a known cause and a known fix — **order the delete against the async writer and
clean up by OWNERSHIP (`propertyId`), never by a collected-id list**, which
CLAUDE.md already states and `e2e/workorders.spec.ts` already demonstrates. S.

**Re-verify the row's premises first (R-150).** R-201 is the argument for it:
**two of that row's four cited sites needed nothing** — one had been fixed by
an unrelated item the day after the review, and one had been correct eight days
*before* the review. Line numbers in a review decay faster than its class.

## What R-201 changed that the next rows touch

- **Three renders now go through `friendlyBusinessDate`**: the deposit slip's
  PDF title (`payments/deposit-actions.ts`), both party-change refusals
  (`packages/core/leases/party-change.ts`), and the §3955 SCRA notice
  (`scra/actions.ts`). `scra/actions.ts` no longer imports `utcToBusinessDate`.
- **`party-change.test.ts` now asserts the rendered SENTENCES**, not just which
  field was flagged. Rewording either refusal turns it red on purpose.
- **`consent-panel.tsx:172` is a KNOWN FALSE POSITIVE — do not "fix" it.**
  `recordedOn`/`revokedOn` arrive as `friendlyTimestamp(...)` output from both
  callers. `friendlyBusinessDate` throws a `RangeError` on that, which is a
  **500 on the lease page**. It is the one surviving hit of the review's
  predicate and it is correct as it stands.
- **A date predicate is bounded by the POSITIONS it names** (D-216). Review
  §15's grep covers `title:`/`label:`/`message:`/`description:` only; the SCRA
  defect sat in a `notice:` position and was structurally unfindable by it.
  Widen to `notice:|subject:|body:|text:|reason:|hint:` if you re-run it.

## Found in R-201, owned by nobody

- **The deposit-slip title and the SCRA notice are held by no test.**
  `scra.test.ts` covers only affidavit lookups; the slip's title is set in
  `apps/web` while `deposit-slip-document.test.ts` asserts only the core
  blocks. Each needs a full fixture for a one-line render. Only the
  party-change pair has an assertion.
- Deposit slips and SCRA notices already issued keep the raw date in their
  stored text. Forward-only; nothing backfills (D-201).
- The demo seed creates no deposit batch and records no SCRA termination, so a
  D-28 walk can see neither fix.
- The widened predicate lives in D-216 and PROGRESS, not in a script.

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-201's first full `npm test` came back **11 failed / 3154 passed in 193.27s**
against a ~20s baseline. **None of it was the code.** Every failure was
`Hook timed out in 10000ms` in a file the item did not touch, and there were
**zero** `too many clients`.

**How it was settled, in order — copy this, it is faster than a stack trace:**

1. `pg_stat_activity` → six connections. No sibling database implicated.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → newest file was
   **yesterday's**. The OS killed nothing. `Killed: 9` names no culprit; this
   is the check that does.
3. `sysctl -n kern.memorystatus_level` → 59% available, `vm.memory_pressure` 0.
4. `lsof -ti :3100` → nothing.
5. **The per-file duration table, which is what actually settled it.**
   `vendors/follow-up.test.ts` took **188s and still PASSED**; the handoff
   already named that file as this symptom's tell. `escalation.test.ts` 153s.
   **A global slowdown across unrelated files is contention, not a regression.**
6. `ps` → idle Playwright `test-server` daemons from **four** projects.

**Killing only THIS repo's, scoped by `cwd`, and re-running gave 3165 passed in
16.73s on the identical tree.**

**Sibling daemons are still resident and are not this repo's to kill** — close
them from their own projects: **`storage business` has held one since
2026-09-05**, `apptbasedservice` has four `chrome-headless-shell` from
2026-09-11, and `clinic` one. A bare `pkill -f playwright` would kill a
sibling's live sweep; scope every kill to `$PWD`.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is nine migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and including
`20260907120000_r175_payment_plans`, so it has no `PaymentPlan` table at all.
`npm run dev` reads `.env.local`, so a walk against the dev branch would 500 on
anything built since R-165. `npm run db:migrate:dev` is the whole fix; it has
still not been run.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Binding for every row in this arc

The review's **"do not build"** list, repeated in the Milestone 14 header and
D-201: no accrual or interest engine before a second state; no Stripe Connect;
no settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
`TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds; **no second
queue** (D-9); **no backfill of anything**; no per-stage turn table, no second
definition of "days vacant".

## Still true from earlier handoffs

- **Rows 81 (R-081), 97 (R-097) and 155 (R-168) are SPLIT-PARENT
  placeholders.** Every child shipped. Ticking them is bookkeeping.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.
- **Row 190 / R-203** is the e-sign half of the payment plan (D-214).

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197) — the second kind hides from an element-by-element
probe; only `document.documentElement.scrollWidth` sees it.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`.** Both give a wall of instant failures with no
`DATABASE_URL`, which reads exactly like the jetsam symptom and is not it.
(`--list` is safe without it, and is how you get the real expected e2e count.)

**Prove a new assertion against the reverted fix** (D-197). R-201 did this: the
revert turned exactly one test red, the new one.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**A seed defect is only visible on a walk** (D-28).

## Leftovers still owned by nobody

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state; the demo seed configures Texas
only.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went; the guarantor portal does not
show the plan. `sms-intake.test.ts`'s `afterAll` has timed out at 10s
intermittently — see the contention section above before treating it as code.

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

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as **unknown**
— verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
