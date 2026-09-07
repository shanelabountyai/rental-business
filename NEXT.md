# Next session

## Pick up: R-175

`docs/prds/06-backlog.md`, row 162 — the next unticked row. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-174 (done, 3ecb18a)

`/jobs` is the first thing that ever read `JobRun` back. `jobHealth()` in
`apps/web/lib/jobs/queries.ts` walks **`SCHEDULED_JOBS`**, not the run table —
a history-driven panel reports perfect health for a job that has never fired.
`rerunJobRun` refuses anything that is not `FAILED` (the run row IS the
idempotency guarantee), and `runDueJobs` catches up missed business dates
bounded to 3 and only where the pair has an earlier run. **D-180** records all
four rules.

Left behind, owned by no item:

- A manager holding a `job_failed` task cannot open `/jobs` to act on it —
  `job.manage` is owner-only, and the task is raised without regard to who can
  act on it. Same cause: only an owner can press the re-run.
- `overdueToday` renders every affected property name inline; a dead cron over
  fifty houses is a wall of names per job.
- Nothing tests `jobHealth()` directly — the query's overdue/missed arithmetic
  is covered only through the page.

Still unowned from R-173: a tenant with a phone but no email still gets a live
PORTAL row and cannot sign in; nothing links a `serve_notice_offline` task to
a `Notice` row.

Still unowned from R-172: no staff field to type a real handover date for an
inherited tenancy whose move-in walk never happened;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment may write both a `PENDING` and a
`SETTLED` row. Recorded as **unknown** — verify against real Stripe.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.

**Check `gh run list --limit 5`** rather than assuming — R-174's own run is
the one to read.
