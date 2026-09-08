# Next session

## Pick up: R-181

`docs/prds/06-backlog.md`, row 168 — the next unticked one. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-180 (done, 6032cd0 + bf3bbdd)

**CI run `34244623019` was still in flight when the session closed.** Check it
(`gh run list --limit 5`) before assuming green — R-179's first run failed.

**D-191.** The per-entity settlement report ships; three LLCs collecting into
one bank account is now visible.

- **`Payment.channel` CANNOT say whether money went through Stripe.** The
  webhook writes `channel: OTHER` for every invoice-driven payment, because an
  invoice event carries no `rail`. A `CARD`/`ACH` filter drops most online
  rent. The discriminator is **`receivedByStaffId`** — the webhook's own, and
  `recordOfflinePayment` is its only writer anywhere in the codebase.
- **An offline check never entered the Stripe balance.** It reaches Stripe as
  an out-of-band payment against the open invoice: the ledger moves, no money
  passes through the balance, and it can never appear in a payout. R-166's
  deposit slips are where that money reconciles.
- **Settlements and reversals are separately dated events off one row.** March
  keeps money returned in April; April carries the clawback. Netting only
  currently-`SETTLED` rows is wrong in both directions.
- **Every money figure in this product is GROSS.** No Stripe processing fee is
  recorded anywhere — no column, no event. Do not let a later report imply a
  net payout.
- `summariseSettlements` is in `packages/core/payments/settlement.ts`; the
  fetch is `apps/web/lib/reports/settlement.ts`.

Left behind, owned by no item:

- Nothing records the inter-entity transfer itself, so "prove they did" rests
  on the bank statement beside a report that is regenerated, not archived.
  R-081d's split (numbers first, artifact as its own row) is the precedent.
- No processing fee anywhere, so no net payout can ever be stated.
- `HAP_ACH` would be counted as a Stripe settlement if anything ever wrote it.
  Nothing does — the channel is in the enum with no writer.
- No `stripePayoutId` and no per-payout grouping: a bank line is matched by
  eye against a population, not by an identifier.
- **Stripe Connect (a connected account per entity) is the real answer** and
  is explicitly not built: it changes every payment path and needs a
  legal-structure decision marked *needs counsel*. Finding 12 re-opens when
  that decision is made.

Still unowned from R-179: a guarantor gets a PORTAL chase with no portal inbox
to read it in; guarantor consent cannot be recorded at all, so D-190's SMS
suppression is permanent; `CHASE_LADDER_DAYS` has nowhere to configure it; the
`rent.chase` Task links to nothing; nothing chases a non-tenant `LeasePayer`.
**`e2e/leases.spec.ts` still flakes on its own cleanup** — `unit.deleteMany`
refuses on `WorkOrder_unitId_fkey` because R-178's lease-end opens six work
orders and the delete races the async writer. It will keep flaking CI.
**The merge-field catalogue still prints raw `YYYY-MM-DD`** — `lease.starts_on`,
`lease.ends_on`, `balance.due_on` and `today`. The D-153 defect where D-154's
grep predicate cannot see it.

Still unowned from R-178: no `cases.stalled` Task links to its subject; a turn
that stalls, resumes and stalls again is flagged once; `TURN_STAGE_DAYS` has
nowhere to configure it; `draftPunchListFromInspection` findings are unstaged.

Still unowned from R-176: nothing warns portfolio-wide that a unit was listed
with an open re-key; a CANCELED re-key reads like one that never happened;
nothing backfills units turned before 2026-09-07.

Still unowned from R-177: the R-032c "was this fixed?" SMS default and the
TCPA question are owner decisions, recorded and unfixed. Email-intake tickets
get no clarify link; no staff "ask them again" button;
`e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

Still unowned from R-175: no e-sign on a payment plan agreement; no
tenant-facing view of the schedule.

Still unowned from R-174: a manager holding a `job_failed` task cannot open
`/jobs` to act on it; `overdueToday` renders every affected property inline;
nothing tests `jobHealth()` directly.

Still unowned from R-173: a tenant with a phone but no email still gets a live
PORTAL row and cannot sign in; nothing links a `serve_notice_offline` task to
a `Notice` row.

Still unowned from R-172: no staff field for a real handover date on an
inherited tenancy whose move-in walk never happened;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment may write both a `PENDING` and a
`SETTLED` row. Recorded as **unknown** — verify against real Stripe.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.
