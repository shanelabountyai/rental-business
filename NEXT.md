# Next session

## R-234 is done (`67ce6ed`, SHA recorded in `344b061`). Start R-235.

**First: read CI** with `gh run list --limit 3` and confirm R-234's push run went green.

**R-235**: the Arc 6 demo walk (D-28). Every row R-222 through R-234 is now ✅ — Milestone 16 is exhausted. The review said what it could not see from source, and two findings need a browser to confirm fixed: finding 1 (a lease that rolls to month-to-month should never show as a vacant house on `/vacancies`) and finding 9 (the dashboard's vacancy-loss tile, now null-with-a-reason for an unpriced unit rather than a cheerful $0). Walk desktop and 412px, both Playwright projects — this is exactly the review posture that found seven defects across 88 pages that all returned 200 last time (R-105). Also carries the standing seed gaps this file has tracked for a while (see below): no demo `REVERSAL` rows, no deposit batch, no guarantor portal login. Size M — this is a review/correctness pass across the whole shipped surface, not a build task, so **Opus** is the right tier; Sonnet is fine if you'd rather trade thoroughness for speed on a walk this large.

**R-234 left behind:**
- No caption on the eviction packet's own photographs (inspection/maintenance/completion/unit) — `PacketCandidate.imageCaption` is optional and unset there, since no geotag is plumbed through its candidates today. It still gets the R-234 fix's main benefit: those photos now actually embed as pages instead of reporting NOT ATTACHED, just uncaptioned.
- GIF/WEBP/HEIC exhibits still report NOT ATTACHED on both packets — D-137's browser-render allowlist is wider than what pdf-lib's `embedJpg`/`embedPng` can embed. Unchanged by this item, not a new gap.
- `rent.decide` Tasks still have no special queue rendering (carried from R-229, still unowned).

**Carried from R-229:**
- **Needs a backlog row:** `checkHabitabilityRepairs` in `apps/web/lib/cases/case-stall-job.ts` uses `rulesFor(...).catch(() => null)`. A DB error reads as "no rule", so the job silently flags no habitability deadline. The probable cause of 3 R-217 test failures under full-suite load; they pass alone.

**Carried from R-228:**
- An unserved entry notice needs the override reason, and a hand service recorded later does not re-judge the window. The showing slot list still offers slots for a tenant who cannot be served. **Needs counsel:** damages for entries already made on the old path.

**Carried from R-227:**
- `payment-plan-job.ts` stamps `liftedAt: new Date()` (R-190's class); the suppressed-fee report is only `heldBackCents`.

**Carried from R-225:**
- No cap check on the MTM rollover rate, no tenant message when an increase is withdrawn, and the R-223 to R-233 migrations are not on the Neon dev branch.

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`. The bare command loads no `.env.test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- Orphaned `node (vitest N)` workers survive a `$PWD`-anchored `pkill`. Find them by cwd.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
