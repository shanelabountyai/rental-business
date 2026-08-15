# Single-Family Rental Operations Platform

Multi-property single-family rental management platform (10–50 units, owner-operator + small team). Learning project, built to professional standards. Same stack and working conventions as the self-storage platform.

## How to work in this repo

- Product source of truth: `docs/prds/`. Build order: `docs/prds/06-backlog.md`, top to bottom, one item (or noted small cluster) per session.
- `docs/prds/07-decisions.md` OVERRIDES any conflicting PRD text. Never re-open a settled decision; append new decisions there instead.
- Stack: Next.js (App Router) + TypeScript, Postgres + Prisma, **Stripe Billing** (subscriptions drive recurring rent; Stripe is the source of truth for invoices and payments, per D-11), Tailwind CSS + shadcn, Auth.js, Resend (email), Twilio (SMS), Vitest/Playwright + axe + Lighthouse, deployed on Vercel.
- Monorepo layout mirrors the storage platform: `apps/web`, `packages/core` (domain logic, money math, metrics), `packages/db` (Prisma schema + migrations).
- Data model: use the canonical entity names in `docs/prds/00-master-prd.md` §13 (LegalEntity, Property, Unit, Lease, Tenant, LedgerEntry, Charge, Payment, Ticket, WorkOrder, Vendor, Inspection, Thread/Message, Notice, Task, Document, AuditLog, StaffUser, JurisdictionRule and supporting entities).
- Money is integer cents. All timestamps UTC in the DB, property-local timezone for display.
- **Jurisdiction rules are versioned, effective-dated configuration — never hardcoded** (D-4). Grace periods, late-fee caps, deposit deadlines, entry-notice hours, notice periods all read from `JurisdictionRule`. Compliance defaults are Texas, built per-state configurable. All legal/notice text is draft-only and not legal advice.
- **The evidence trail is the product.** Every message, notice, photo, payment, approval and privileged mutation is timestamped, append-only, and exportable.
- **Stripe is the system of record for money; `LedgerEntry` is an append-only projection of it** (D-11). Never write a charge or payment directly into the projection — it is built from Stripe webhooks, and a row that Stripe does not know about is a reconciliation bug. Corrections are reversing entries, never edits or deletes.
- **Stripe executes, core decides** (D-12). If a statute could change a number — late-fee amount and its cap, proration, allocation order, days-past-due — `packages/core` computes it and pushes it to Stripe as an invoice item. Never let Stripe generate a jurisdiction-dependent amount.
- Never store card, bank, or SSN data. Stripe-hosted fields and provider-hosted screening flows only.
- Screening and e-sign run against simulated adapters (PRD 00 §14) — never assume a real vendor API.
- Every module sends notifications through the notification engine (R-030) — no module hand-rolls its own sending.
- One `Task` entity serves every staff work queue. Do not invent a second queue table (D-9 — a lesson carried over from the storage build).
- Accessibility: WCAG 2.1 AA is an acceptance criterion on tenant- and vendor-facing work, not a later cleanup.
- After completing a backlog item, in this order: run tests → mark the item ✅ in `docs/prds/06-backlog.md` → add its entry to `docs/PROGRESS.md` → commit.
- `docs/PROGRESS.md` is the running narrative of what has been built. One entry per completed item, with its commit SHA and three things: **what it built**, **what it decided** (choices a later session must not silently reverse), and **what it left behind** (deliberate gaps and which item owns them). Note any real bug found along the way. Keep it factual — it is a record, not a changelog of intentions.
- Record the SHA in a small follow-up commit, not by amending. Amending changes the SHA you just wrote down, leaving `PROGRESS.md` pointing at a commit that no longer exists.
- Also update the same-day PRD when an item settles something the PRD left open, and append owner decisions to `07-decisions.md` with a new D-number rather than resolving them silently.
- Commit after every completed item with a message like `R-012: work order lifecycle`.

## The gate

Nothing is done until all four pass:

```
npm run lint && npm run typecheck && npm test && PORT=3100 npm run test:e2e
```

- **This repo owns `:3100`, and that is now the config default** — `PORT=3100` in the command above is belt-and-braces rather than load-bearing. It used to be mandatory because the default was 3000 and the sibling self-storage repo *hardcodes* `localhost:3000`: with `reuseExistingServer` on, forgetting the variable pointed this suite at that app, which fails in ways that make no sense. The default now removes the footgun instead of documenting it.
- **e2e runs against a PRODUCTION BUILD, not `next dev`** (R-042). `playwright.config.ts` starts `npm run e2e:server`, which builds then serves. `E2E_DEV=1` restores the dev server when you want the error overlay or a stack trace against real sources. Two reasons, and the second is why it is not negotiable on a laptop running several projects:
  - **Speed.** The full sweep went from **16+ minutes to 4.1 minutes**, same 596 tests.
  - **`next dev` holds ~1.9 GB.** The Turbopack compiler, module graph, source maps and HMR state stay resident for the whole run, and five Chrome workers are another ~490 MB each. On a machine already running other projects' dev servers that tips into swap, and **macOS kills the largest process — the server**. Every test after that moment fails in about a second with `ERR_CONNECTION_REFUSED`, which does not read as an environment problem: it reads as fifty-five broken tests. It cost most of a session to diagnose, twice, because a concurrent `npm run build` was a plausible-looking red herring the first time. If you ever see a wall of ~1s failures, check `lsof -ti :3100` and `sysctl -n vm.swapusage` **before** reading a single stack trace.
- **The full sweep belongs in CI, not on the laptop.** `.github/workflows/ci.yml` already runs it on every push against a throwaway Postgres. Locally, run `lint`, `typecheck`, `npm test` and only the specs you touched; let CI own the 596.
- **CI runs checks the local gate cannot, and it is not optional to look at it.** `.github/workflows/ci.yml` applies every migration to a **throwaway Postgres from scratch** and then runs `prisma migrate diff --exit-code` for schema drift. Locally, migrations are only ever applied incrementally to a branch that already has data, so neither check can happen here. A hand-written migration that is out of order, that does not apply to an empty database, or that creates something Prisma cannot express is invisible until CI says so — which is exactly how a partial index sat in `SmsOptOut` reporting drift on every run. Run the drift check before pushing a schema change:
  ```
  npx dotenv -e .env.local -- npx prisma migrate diff \
    --from-schema-datasource packages/db/prisma/schema.prisma \
    --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code
  ```
- **Never edit a migration that has already been applied.** Prisma records applied migrations by checksum, so editing the file leaves the new SQL unrun while `migrate deploy` reports nothing pending — the column exists in `schema.prisma` and not in the database. Add a new migration instead (R-039a hit this).
- **`npm run build` is a distinct check.** `typecheck` and `vitest` both miss the Next.js boundary rules below. Run it whenever a `'use server'` module or a Server→Client prop changed.
- A stalled run leaves a dev server behind: `pkill -f playwright; lsof -ti :3100 | xargs -r kill -9`.
- **Never run two sweeps at once.** `reuseExistingServer` means a second run ADOPTS the server on :3100 rather than starting its own — so when the first run finishes, its teardown SIGKILLs the server the second is still using, and the second collapses into connection-refused failures partway through. Three sweeps died this way before it was spotted, and the OS was blamed twice. **`Killed: 9` names no culprit**: jetsam, a person, a `pkill` and another Playwright teardown all produce SIGKILL identically. The check that settles it is `ls /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` — macOS writes one file per memory kill, so no file means the OS did not do it.
- **Read the e2e summary, not the tail of it.** `0 failed` and exit 0 are not the gate — the gate is `passed + skipped + flaky` reconciling against `npx playwright test --list` (`Total: N tests`). Piping the run through `tail` shows you the failures and hides how much actually ran, so a partial sweep and a full one look identical. `retries: 1` means a test that fails once and passes is reported as **flaky** and counted separately; a run with flaky tests still exits 0.
- Every `packages/core/<domain>` needs a hand-added `"exports"` entry in `packages/core/package.json`, or the import resolves nowhere.

## Invariants the database enforces

`LedgerEntry`, `AuditLog`, `Message` and `Notification` are append-only by trigger — UPDATE, DELETE and TRUNCATE are all refused at the database, not in application code. Three consequences that have each cost a debugging session:

- **A foreign key pointing at one of those tables must be `onDelete: Restrict`.** `SetNull` looks safe on a nullable column but can never fire: the cascade's UPDATE hits the trigger and the whole delete fails at runtime. This has been fixed twice (`Message.ticketId`/`workOrderId` in R-032, the `LedgerEntry` keys in R-034) — do not reintroduce it.
- **You cannot amend an append-only row after the fact.** Late association needs a join table (`WorkOrderMessageLink`), not an UPDATE. Corrections to the ledger are reversing entries.
- **Test and seed cleanup cannot delete a row an append-only table references.** Retire or deactivate instead. The demo seed's `--reset` does exactly this, and R-035's reconciliation check exists partly because a cleanup that deleted `ProcessedStripeEvent` rows left real ledger orphans behind.

Migrations are hand-written SQL — triggers, partial indexes and backfills do not survive a generated diff.

## Traps that only fail at runtime

- **A `'use server'` module may export only async functions.** A sync export passes typecheck and vitest and fails in `npm run build`.
- **A plain function cannot cross the Server→Client boundary.** Only a `'use server'` export has an identity the client can call back to. `npm run build` does *not* catch this — the page 500s in the browser. Bind the action server-side and pass the bound action down.
- **A `loading.tsx` turns every `notFound()` beneath it into an HTTP 200.** The file wraps its segment in a Suspense boundary, so the response starts streaming with a 200 header before the page runs — and a status already on the wire cannot be retracted. The not-found *page* still renders, so it looks completely correct in a browser; only the status line is wrong. That matters here because ROLE-01 answers **404 rather than 403** for a record outside your scope, deliberately, so "forbidden" cannot be used to confirm a record exists. Eight scoping specs across seven files assert `expect(response.status()).toBe(404)` and all of them went red the moment a `loading.tsx` was added two directories above them. R-099 tried this and reverted it; if you want loading states, they belong on leaf segments that never call `notFound()`, and the reason has to be written next to them.
- **`onClick` is inert until hydration.** Anything that must work on first paint is a real `<form action>` + `useActionState`, not a button with a handler.
- **Prisma `@db.Date` comes back as UTC midnight, and converting it *through* a timezone is the same bug wearing a different hat.** `utcToBusinessDate(value)` is the reader for a date-only column; `businessDate(instant, zone)` is the reader for a real timestamp. R-042 used the second on `Lease.startsOn` and every move-in west of UTC silently gained a day — a 12-day March proration billed as 13, an extra day of rent on every partial first month, with all ten core unit tests passing because the defect was entirely in how the date was read out of the database. If a value is a calendar day, no zone may touch it.
- **Prisma `@db.Date` comes back as UTC midnight.** Reading it with local `getDate()`/`getMonth()` is off by one for any server west of UTC — that is exactly how `daysPastDue` once reported a day late *on* the due date. Date-only values are `BusinessDate` (a `YYYY-MM-DD` string, `packages/core/scheduling/local-time.ts`); timestamps are real `Date`s. Do not mix them.
- **A simulated adapter must not agree with us by construction** (D-27). If the simulator answers from the same column the decision compares against, every "they differ" branch is dead code that no test can reach. Give the simulator its own state for what it was *told*.
- **Adding a value to a status enum is never one edit.** Grep every list and literal that reads it before moving on. `VERIFIED` existed in the enum and in the write that set it, and in neither of the two lists that read it — the tenant's confirmation deleted the job from every screen and killed the vendor's link (R-036b). Fixing that made two more statuses reachable on the vendor page, where a `=== 'WORK_COMPLETE'` guard was then wrong in two files. Each of these is invisible from inside the item that introduces it. **Walk the demo checkpoint when a milestone closes** (D-28) — that is how all of them were found.

## Test suite rules

- **Never call a global sweep in a test.** `dispatchPendingNotifications()` takes `only: { deliveryIds }` and `dispatchOutbox()` takes `only: { eventIds }` — use them. An unfiltered sweep passes today and becomes the slowest, flakiest thing in the suite three items later; that has now happened three times. One test may exercise the genuine global sweep; it gets an explicit long timeout and says why.
- **A timeout set at the measured cost is a flake generator.** Three separate "flaky" tests this month were each a deadline with no headroom, not randomness: the escalation sweep's paging tests measured 25–28s against a 30s budget (R-102b), and the emergency submit tests measured 54.8–59.7s against the config's 60s default (R-040e). Anything that **pages somebody** is slow by construction — a page resolves the rota, then per recipient per channel runs a preference lookup, an idempotency check, two inserts and an audit row, then two more round trips to claim and send — so time it in isolation and set the ceiling well above what you measure, with the measurement written next to it. Reaching for "flaky under parallel load" without timing it first is how the same diagnosis gets missed three times.
- **A spec that sweeps globally must first retire the debris it is about to pay for** (R-102). Obeying the rule above is what creates the problem: every spec dispatches only its own rows, so everything else stays QUEUED for ever, and the shared database reached 27,392 delivery rows. In production the hourly cron drains that table and somebody acknowledges an emergency within minutes; in the test environment nothing plays either role. The two global-sweep specs each retire rows **older than an hour** in `beforeAll` — old enough that no concurrently-running fixture can be touched, since every fixture here is created inside its own test. Without it the cost of those specs grows with the age of the database and they eventually blow any timeout you pick.
- Anything that writes a phone number takes it from `uniquePhone()` in [e2e/fixtures.ts](e2e/fixtures.ts) — never a literal. A crashed run left an active tenant holding the hard-coded number, and SMS routing correctly refused to guess between two candidates for an unknown number of runs afterwards.
- `waitForURL(/\/leases\/[a-z0-9]+$/)` also matches `/leases/new` and resolves instantly. Exclude it: `(?!new$)`.
- Close every `browser.newContext()`. A leaked context surfaces as an unrelated spec failing on someone else's page.
- `e2e/**` is inside the `apps/web` tsconfig — e2e specs are typechecked, so treat a type error there as a real failure.
