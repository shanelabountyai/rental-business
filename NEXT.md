# Next session

## R-217 is done and CI is green. Pick up R-218: a deposit-dispute packet

R-217 shipped as `f8eaa2c`. CI run `35160625191` passed both jobs (verify, and e2e/axe/Lighthouse). That run is where R-217's build and its "Repair due" e2e assertion were first verified, because they could not run locally. **Read CI on the run itself with `gh run list --limit 5`.** Do not copy a CI line forward.

**Start here:** `docs/prds/06-backlog.md`, row 205 / **R-218**. Re-verify the finding before touching anything. The record is thirteen for thirteen.

Before any local build, check `ps -Ao pid,etime,command | grep vitest`. Leaked `alongside/backend` vitest workers starved R-217's build for over an hour.

## What R-217 established (D-235)

- `JurisdictionRule.habitabilityRepairDays`, with TX at 7. **`REPAIR_CLOCK_RUNNING`** in `apps/web/lib/maintenance/habitability-clock.ts` is the one "still unrepaired" predicate. The sweep and the ticket page both read it.
- The clock starts when the ticket was opened. **A merge does not stop a duplicate's clock**; it stops when the ticket it merged into is repaired or closed.
- Halfway (URGENT) and overdue (EMERGENCY) are separate Task types.

## What R-217 left behind

- No acknowledgement window, no tenant-facing deadline, and only TX has a period (**needs counsel**).
- A flagged duplicate and a flagged survivor can each raise a Task for one problem.

Everything older still stands; it is in git history at `7fb5ffb:NEXT.md` and `3f56889:NEXT.md`.
