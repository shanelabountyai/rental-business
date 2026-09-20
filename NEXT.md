# Next session

## R-233 is done (`4c93e96`, SHA recorded in `7215f98`). Start R-234.

**First: read CI** with `gh run list --limit 3` and confirm R-233's push run went green.

**R-234**: the deposit-dispute packet lists the photographs instead of containing them. `appendPdfs` in `apps/web/lib/deposits/packet.ts:157-166` takes PDFs only, so a JPEG/PNG move-in or move-out photo is named in the packet's text but never appears as a page. Row 221 in `docs/prds/06-backlog.md`; review finding 13. Fix: render JPEG and PNG as pages, move-in above move-out per item, carrying capture time and R-068's stored geotag, limited to D-137's allowlist (never trust `Document.contentType` for what to render — sniff it, same reasoning as `documentResponse`). Its depends-on, R-226, is already ✅ (`baselineMoveInFor` walks a renewal chain to the first lease), so R-234 is unblocked. Size S–M, no schema change expected — Sonnet is fine.

**R-233 left behind:**
- Nothing new. `rent.decide` Tasks still have no special queue rendering (carried from R-229, still unowned).

**Carried from R-229:**
- **Needs a backlog row:** `checkHabitabilityRepairs` in `apps/web/lib/cases/case-stall-job.ts` uses `rulesFor(...).catch(() => null)`. A DB error reads as "no rule", so the job silently flags no habitability deadline. The probable cause of 3 R-217 test failures under full-suite load; they pass alone.

**Carried from R-228:**
- An unserved entry notice needs the override reason, and a hand service recorded later does not re-judge the window. The showing slot list still offers slots for a tenant who cannot be served. **Needs counsel:** damages for entries already made on the old path.

**Carried from R-227:**
- `payment-plan-job.ts` stamps `liftedAt: new Date()` (R-190's class); the suppressed-fee report is only `heldBackCents`.

**Carried from R-226:**
- Whether the portal's `scope.leaseIds` includes a renewed tenant's ended predecessor. R-234 is unblocked.

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
