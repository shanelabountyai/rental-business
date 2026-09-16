# Next session

## R-217 shipped as `f8eaa2c`, and its CI run MUST be read first

**R-217's build and e2e were never verified locally.** About 50 vitest processes from `alongside/backend` held the CPU, the e2e build timed out, and a standalone `next build` stalled in "Running TypeScript" for over an hour. The owner chose to push and let CI verify. **First move: `gh run list --limit 5`, and read the run for `f8eaa2c` / its record-the-SHA commit.** If it is red, fix it before starting anything else. The new assertion to watch is `maintenance-phone-log.spec.ts`'s "Repair due" row, in both projects.

Before any local build, check `ps -Ao pid,etime,command | grep vitest`. Leaked `alongside/backend` vitest workers will starve it.

## Then: the next ⬜ row in `docs/prds/06-backlog.md` after R-217 (row 204)

Re-verify the finding before touching anything. The record is thirteen for thirteen.

## What R-217 established (D-235)

- `JurisdictionRule.habitabilityRepairDays`, with TX at 7. **`REPAIR_CLOCK_RUNNING`** in `apps/web/lib/maintenance/habitability-clock.ts` is the one "still unrepaired" predicate. The sweep and the ticket page both read it.
- The clock starts when the ticket was opened. **A merge does not stop a duplicate's clock**; it stops when the ticket it merged into is repaired or closed.
- Halfway (URGENT) and overdue (EMERGENCY) are separate Task types.

## What R-217 left behind

- No acknowledgement window, no tenant-facing deadline, and only TX has a period (**needs counsel**).
- A flagged duplicate and a flagged survivor can each raise a Task for one problem.

Everything older still stands; it is in git history at `7fb5ffb:NEXT.md` and `3f56889:NEXT.md`.
