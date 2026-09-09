# Next session

## The review-finding backlog is finished. Read this before picking anything up.

R-183 was the last of the 2026-09-05 operator review's findings. **Three rows
are unticked and none of them is "the next item":**

- **Row 81 (R-081) and row 97 (R-097) are SPLIT-PARENT placeholders.** Every
  child shipped — R-081a/b/c/d and R-097a/c/d/e/f are all ✅ (R-097b was cut,
  not built, per D-121). The rows are left unticked because they describe a
  split rather than work; do not "pick them up" looking for something to
  build. Ticking them is a bookkeeping call somebody should make deliberately.
- **Row 93 (R-093) is externally blocked, not ready.** Real vendor drivers
  replacing the simulators (D-7): a screening provider with an FCRA agreement,
  an e-sign provider, listing syndication feeds, a certified-mail API,
  QuickBooks Online. Phase 3, size L, and every one of them needs a signed
  commercial relationship first. It is not a laptop item.

**So the next move is a decision, not a row.** Reasonable candidates, in the
order I would rank them:

1. **Walk the demo checkpoint (D-28).** A milestone has closed and the last
   walk was R-105, which found seven defects across 88 routes that all
   returned 200. Setup is in `CLAUDE.md` → *Seeing the demo*, and the `:demo`
   suffix on every script is load-bearing.
2. **Clear the named leftovers below.** Several are real defects with owners
   of nobody — the `e2e/leases.spec.ts` cleanup flake is the one actively
   costing CI runs.
3. **Commission a fresh review.** The last one is spent.

Model: recommend at the start of whatever gets picked, per the global
convention.

## Context from R-183 (done, d8d1d0f + 2f20ee8)

**CI for R-183 is GREEN on both jobs** (`34371202028`), checked before the
session closed rather than assumed. R-182's fix run (`34368255042`) was green
too. Nothing is in flight — R-141's lesson is that this sentence gets copied
forward instead of checked, so re-verify with `gh run list --limit 5` rather
than trusting this line.

**D-195.** Deposit escrow/interest is now a loud gap rather than two sentences
that read as a promise.

- **Named where it BREAKS, not where the column is empty.** "A disposition
  letter would go out short by the interest owed" is actionable;
  "`interestAccruedCents` is never written" is not.
- **The write is NOT refused** — same call R-182 made for an empty holiday
  list. An interest-required state must stay recordable; the block is the
  existing pre-activation legal-review gate, not a code path.
- **A test that passes either way protects nothing.** `deposits.test.ts`
  matched `/interest/i`, which the old bare string satisfied too. The new
  assertion was proven to fail by reverting the string.

**One full-suite run went red first, cause recorded as UNKNOWN.** Seven
unrelated files, 30s timeouts plus a `Task_propertyId_fkey` violation and a
`25P02` aborted transaction. Re-ran green, totals reconciling at 3058 either
way. `pg_stat_activity` was only checked *after* the run, so connection
exhaustion is plausible and unconfirmed — **if this recurs, check
`pg_stat_activity` DURING the run**, which is the one measurement that would
settle it.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or layout (D-194, R-182). A `<select>` is as
wide as its widest `<option>`; a long one blew the page to 930px inside a
412px viewport, Chromium scaled the page, and Playwright's clicks missed by
the scale offset. Six tests failed in CI having passed locally. `min-w-0`
inside `SelectField` does not save you — **every flex ancestor between the
control and the form has to allow the shrink**.

## Leftovers still owned by nobody

From R-183: no accrual engine, no interest rate on `JurisdictionRule`, and
`Deposit.escrowAccountRef` / `interestAccruedCents` are still written by
nothing — deliberate, and not to be started until a property in such a state
is onboarded. Nothing computes what the interest would have been. A bonded
tenancy in an interest state shows no obligation on the lease panel while the
state-level gap is still listed.

From R-182: `noticePeriodCheck` (LEASE-12) and `renewalCheck` (LEASE-09) still
count calendar days whatever `dayCountBasis` says — they subtract two `Date`s,
and fixing them is R-042's bug class. The coverage screen names both.
`assessEvidence`'s presumption period takes no basis. Nothing seeds a holiday
list for any state.

From R-181: a texted-in tenant never gets the quotable reference; the
acknowledgement rides the hourly outbox cron so it can lag an hour;
`entry.notice` names no ticket; no e2e walks intake → acknowledgement.

From R-180: nothing records the inter-entity transfer; no processing fee, so
no net payout can be stated; `HAP_ACH` would be counted as a Stripe settlement
if anything wrote it. **Stripe Connect is the real answer**, explicitly not
built — needs a legal-structure decision marked *needs counsel*.

From R-179: a guarantor gets a PORTAL chase with no portal inbox; guarantor
consent cannot be recorded, so D-190's SMS suppression is permanent;
`CHASE_LADDER_DAYS` has nowhere to configure it. **`e2e/leases.spec.ts` still
flakes on its own cleanup** — `unit.deleteMany` refuses on
`WorkOrder_unitId_fkey` because R-178's lease-end opens six work orders and the
delete races the async writer. It will keep flaking CI. **The merge-field
catalogue still prints raw `YYYY-MM-DD`** — `lease.starts_on`, `lease.ends_on`,
`balance.due_on`, `today`.

From R-178: no `cases.stalled` Task links to its subject; a turn that stalls,
resumes and stalls again is flagged once; `TURN_STAGE_DAYS` unconfigurable;
`draftPunchListFromInspection` findings are unstaged.

From R-177: the R-032c "was this fixed?" SMS default and the TCPA question are
owner decisions, recorded and unfixed. Email-intake tickets get no clarify
link; `e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

From R-176: nothing warns portfolio-wide that a unit was listed with an open
re-key; a CANCELED re-key reads like one that never happened.

From R-175: no e-sign on a payment plan agreement; no tenant-facing view of the
schedule.

From R-174: a manager holding a `job_failed` task cannot open `/jobs` to act on
it; nothing tests `jobHealth()` directly.

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in.

From R-172: no staff field for a real handover date on an inherited tenancy;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
