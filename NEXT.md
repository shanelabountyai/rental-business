# Next session

## R-235 is done (`4e3ffc4`). Start R-236.

**First: read CI** with `gh run list --limit 3` and confirm R-235's push run went green.

**R-236**: a recipient's notification settings offer only what the product actually sends them. The backlog row carries the evidence and the measured audience (`rental_test`'s `Notification` rows by category × recipient type). Core map in `packages/core/notifications/categories.ts`, read by `getPreferences`; the save action refuses out-of-audience categories; three `notifications.spec.ts` lock tests move from staff `/account` to the tenant portal. Size S–M. Mechanical but touches a locked-category rule, so **Sonnet** is fine.

**R-235 left behind:**
- `/money/deposits` has still never shown a batch. The block is not MFA (the walk enrolled TOTP in minutes). The demo's arrears have no open Stripe invoice, so a check is correctly refused. Needs an invoice at Stripe or a simulator demo run. Owned by nobody.
- The demo seed writes a future `moveOutAt` on two ACTIVE leases, a state the product cannot produce. Harmless today (see PROGRESS).

**Carried from R-234:**
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

- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`. (Guarantor login and a REVERSAL now seeded, R-235.)
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
