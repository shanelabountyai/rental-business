# Progress — Rental Operations Platform

The running narrative of what has actually been built. One entry per completed backlog item, appended in build order. This is a record, not a plan — `06-backlog.md` holds intentions, this file holds facts.

**Entry format.** After completing an item: run tests → mark it ✅ in `06-backlog.md` → add the entry below → commit → record the SHA in a small follow-up commit (never by amending, which would change the SHA you just wrote down).

```
## R-0XX — <item name>
**Commit:** <sha>  ·  **Date:** YYYY-MM-DD

**What it built.** One or two sentences of fact.

**What it decided.** Choices a later session must not silently reverse. If it settles something the PRD left open, also update the PRD; if it's an owner-level call, append a D-number to `07-decisions.md` instead of deciding here.

**What it left behind.** Deliberate gaps, and which item owns each one. Note any real bug found along the way.
```

---

## R-001 — Monorepo & app scaffold
**Commit:** `d99e929` (scaffold), `8171958` (verification fixes)  ·  **Date:** 2026-08-01

**What it built.** The npm-workspaces monorepo (`apps/web`, `packages/core`, `packages/db`) on Next.js 16 App Router + TypeScript, Tailwind v4 + shadcn, Prisma 6 against Postgres, Vitest for unit tests and Playwright for e2e, and a CI workflow that runs migrate/seed/drift-check against a throwaway Postgres service before lint, typecheck, test, build, e2e + axe and Lighthouse. Secrets are handled by `.env.example` (names, committed) plus `.env.local` (values, gitignored), loaded through `dotenv-cli` so every script sees the same environment. The placeholder home route exercises the `packages/core` money helpers so the scaffold's own gates have something real to check.

**What it decided.**
- **Money helpers land in `packages/core` from commit one, and the home page consumes them.** The scaffold's gates are only meaningful if they run over real code; a placeholder page with no imports would have let `packages/core` rot untypechecked.
- **The accessibility gate exists before the first screen.** `e2e/smoke.spec.ts` runs `@axe-core/playwright` over `/` at `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` and asserts zero violations. Per CLAUDE.md this is an acceptance criterion, not a cleanup — a gate added after twenty screens is a gate that gets waived.
- **Playwright's default project is a phone viewport** (`Pixel 7`), with desktop second. Tenant, tech and vendor surfaces are mobile-primary per master PRD §6.5.
- **`packages/db` exports the Prisma client with an explicit `./generated/client/index.js` path**, not a bare directory import — bundler resolution papers over the directory form, plain Node running `seed.mts` does not and fails with `ERR_UNSUPPORTED_DIR_IMPORT`.
- **The whole monorepo is typechecked from `apps/web/tsconfig.json`** rather than from per-package tsconfigs, via `../../packages/**/*` in `include`. One tsc invocation, one config; revisit only if the packages need genuinely different compiler options.

**What it left behind.**
- `packages/db/prisma/schema.prisma` has no models yet, so CI's `prisma migrate deploy` is a no-op and `db:seed` seeds nothing. **R-002** owns the real schema and the first migration; the drift check in CI starts having teeth then.
- The home route at [apps/web/app/page.tsx](apps/web/app/page.tsx) is a placeholder. **R-007** replaces it with the admin shell, **R-013** with the owner dashboard.
- Vitest runs in the `node` environment with no jsdom and no React plugin. Deliberate — the tests this product needs (late-fee caps, proration, allocation order, days-past-due) are pure functions in `packages/core`. Whichever item writes the first component test adds jsdom.
- No auth, no RBAC, no property scoping. **R-003**/**R-004** own those; nothing in this commit should be read as an authorization pattern.
- Stripe underwriting: the backlog notes the multi-LLC KYB application is meant to be *submitted* at R-001 because it has real lead time (R-034 depends on it being done). That is an owner action outside the repo and was not performed by this session.

**Bugs found while verifying.**
- **CI could not have run.** `package-lock.json` was never committed, and the workflow's first step is `npm ci`, which hard-fails without a lockfile. Now committed.
- **The typecheck gate silently skipped `packages/db`.** `tsc` only follows the import graph, and nothing in `apps/web` imports `packages/db` yet, so a deliberate type error planted there passed `npm run typecheck` clean. `packages/core` was covered only incidentally, because the home page imports it. Fixed by adding the packages to `apps/web/tsconfig.json`'s `include` (with Prisma's generated client excluded); re-probed with planted errors in `packages/db/index.ts` and in a test file, and both now fail the gate. Worth noting the gate was about to be handed a whole workspace of Prisma code in R-002.

---

## R-002 — Core data model & migrations
**Commit:** _pending_  ·  **Date:** 2026-08-01

**What it built.** The 27-model Prisma schema and the first migration, using the canonical entity names from master PRD §13: `LegalEntity` → `Property` → `Unit` → `Lease` → `LeaseTenant`/`Guarantor`, the money tables (`LeasePayer`, `Charge`, `PayerAllocation`, `RecurringCharge`, `Payment`, `LedgerEntry`, `Deposit`), maintenance (`Ticket`, `WorkOrder`, `Vendor`), evidence (`Thread`, `Message`, `MessageDelivery`, `Notice`, `Inspection`, `InspectionItem`, `Document`) and operations (`Task`, `JurisdictionRule`, `AuditLog`, `StaffUser`). Every money field is an integer-cents `Int`; every percentage is basis points; every operational row carries `propertyId` directly. The migration ends with raw SQL that makes `LedgerEntry`, `AuditLog` and `Message` append-only at the database level. `packages/db/schema.test.ts` proves the triggers reject and the two-payer split round-trips — 9 tests, each inside a transaction that never commits, so the suite leaves no rows behind.

**What it decided.**
- **The two-payer ledger shape, recorded as D-13** (answers OQ-2, confirms OQ-12). `LeasePayer` is one payer of one lease and holds that payer's Stripe Customer and Subscription ids — which is what "a Stripe invoice has exactly one payer" forces. `PayerAllocation` splits every `Charge` across the lease's payers so the lease still shows one balance. **An ordinary lease is one `LeasePayer` carrying the whole charge: one code path, not two.** Nothing here knows what a housing authority is beyond a `PayerType` value; the voucher features stay in R-048.
- **`LeasePayer.portionCents` is nullable, meaning "the remainder."** A single-payer lease therefore needs no number kept in sync with rent, and historical splits live on `PayerAllocation` — so a mid-stream recertification never rewrites what was already billed.
- **Append-only is enforced by database trigger, not convention.** A `reject_mutation()` function raises on UPDATE and DELETE for the three evidence tables, plus statement-level guards because row triggers do not fire on TRUNCATE. Consequence a later session must plan around: **those tables cannot be cleared with `deleteMany` or `TRUNCATE`** — use `prisma migrate reset`, which drops the schema and the triggers with it.
- **`Message` is immutable, so delivery status moved to `MessageDelivery`.** A webhook must be able to move QUEUED → DELIVERED → READ; the message body is evidence and must not be editable in the same row. Splitting them is what lets both be true.
- **Timestamps are Prisma's default `DateTime` (UTC), and property-local calendar days are `@db.Date`.** `Task.businessDate`, `Charge.dueOn`, `Deposit.dispositionDueOn` and the rule effective dates are dates, not instants — "the 3rd" in Houston is not a moment in time. Timestamptz was considered and rejected: Prisma is the only writer and normalizes to UTC, and mixing the two annotations is worse than either.
- **`Task`'s idempotency key is `(type, subjectId, businessDate)` with all three NOT NULL** (D-9). Nullable columns in a unique index do not constrain anything, because NULLs never compare equal — that is why `subjectId` is required rather than optional.
- **No taxpayer identifiers anywhere.** `LegalEntity` deliberately has no EIN column: a single-member LLC often uses the owner's SSN as its TIN, and CLAUDE.md forbids storing SSNs. Vendor W-9s are a `Document` plus a boolean flag, never a number.
- **Statutory numbers are stored with the rule that produced them** (D-12). `Charge.jurisdictionRuleId`, `Notice.jurisdictionRuleId` and `Deposit.dispositionDueOn` freeze the version and the deadline, so a rule change never moves a clock already running or makes an old charge unexplainable.

**What it left behind.**
- `JurisdictionRule` is an empty table. **R-010** owns the Texas seed, the `rulesFor(property, asOf)` resolver, and the attorney review the `citation`/`reviewedBy` columns exist to record. Until then nothing in the product can compute a late fee, and that is correct.
- **`PayerAllocation` rows are not constrained to sum to their charge.** Postgres cannot check a sum across sibling rows without a trigger, and a trigger would fire mid-insert on a legitimately half-built allocation. This is core's invariant to hold and core's test to prove — it belongs to the item that first writes allocations (**R-034**). The unique constraint on `(chargeId, leasePayerId)` is in place, which stops the double-post bug; the sum is still unguarded at the database.
- **No `StaffPropertyAssignment`, no roles, no permissions.** `StaffUser` is identity only. **R-003** adds credentials, **R-004** adds roles-as-data and the scoping rows. There is no `isSuperuser` and per D-5 there never will be.
- Entities named in PRD §13 but not in R-002's row are deliberately absent: `Application`, `ScreeningDecision`, `LeaseHold`, `ComplianceItem`, `MaintenanceSchedule`, `VendorLink`, `Listing`, `NotificationPreference`, `Consent`. Prisma migrations are additive; the items that own those features add their tables.
- `Document` has no soft-delete or retention columns yet — **R-012** owns the 30-day undelete and the per-class retention config (DOC-05).
- `LedgerEntry.stripeEventId` is indexed but **not unique**: one Stripe event can legitimately project to several entries. Webhook idempotency needs a processed-event table, which is **R-034**'s.
- **Unit operational data is not here** — access codes with reveal history, appliance serials, filter sizes, shutoff locations and photos (PROP-03). **R-009** and **R-024** own those; they are sub-entities, not columns.
- **`npm test` now requires a reachable database.** The schema tests run against `DATABASE_URL` (Neon in dev, the throwaway service in CI), which makes the unit suite network-dependent — ~5s instead of ~300ms. Accepted rather than skipped: a trigger nobody exercises is a trigger nobody can trust, and the R-001 verification already showed what a silently-skipped gate costs. If the loop gets annoying, split `test:unit` from `test:db` rather than deleting the coverage.

**Bugs found along the way.**
- **The e2e suite silently ran against the wrong application.** `playwright.config.ts` hardcoded port 3000 with `reuseExistingServer`, and the sibling self-storage repo's dev server was already on 3000 — so the smoke test loaded that product's homepage and failed on a missing heading. The accessibility gate behaved correctly (it failed loudly rather than passing against a foreign app), but the two suites could not run side by side. The port is now `process.env.PORT`, default 3000 — unchanged for CI, overridable locally.
