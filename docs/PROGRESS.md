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
**Commit:** `e2f8565`  ·  **Date:** 2026-08-01

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

---

## R-003 — Auth foundation
**Commit:** _pending_  ·  **Date:** 2026-08-01

**What it built.** Authentication for all three principals. Staff sign in with email and password (scrypt) and a TOTP second factor with recovery codes; tenants sign in with a short-lived single-use magic link and no password; vendors get a signed single-use work-order link and no account at all (D-6). Plus per-IP rate limiting, per-account exponential lockout, password reset, and "sign out of every device". The pure logic — hashing, token minting, TOTP, MFA-secret encryption, rate-limit and lockout decisions — lives in `packages/core/auth` with 57 unit tests; the storage half lives in `apps/web/lib/auth` with 15 integration tests; the flows have 46 e2e tests including an axe scan on every auth screen.

**What it decided.**
- **Auth.js v5 with JWT sessions and no database adapter.** The adapter's `User` table would have to be one identity for both staff and tenants, and R-002 settled those as distinct entities for good domain reasons. Two Credentials providers over our own tables is less machinery than bending the adapter into a shape it does not have.
- **Revocation is a `sessionsValidFrom` watermark, checked on every request.** Auth.js does not support database sessions with the Credentials provider — a documented limitation, not a preference — and a signed JWT cannot be deleted server-side. So `StaffUser` and `Tenant` each carry a watermark, and the `jwt` callback re-reads the account on every authenticated request and returns null if the account went inactive or the watermark moved past the token's issue time. Deactivation, password reset and "sign out everywhere" are all one column update. **ROLE-06's "access killed within 1 minute" depends entirely on this**, so it is asserted by e2e against a real browser and a real cookie rather than taken on trust. It costs one database round-trip per authenticated request; the upgrade path if that ever matters is a ~30s cache, never removing the check.
- **Secrets live on `StaffCredential`/`TenantCredential`, not on the identity rows.** `StaffUser` and `Tenant` are read constantly by ordinary product code, and a password hash riding along on every one of those reads eventually lands in a log or a serialized payload. Fetching a credential now requires asking for it by name.
- **scrypt from `node:crypto`, not bcrypt or argon2 from npm.** A memory-hard hash in the standard library: no native build step, no supply chain to audit on the one path where a compromised package is worst. OWASP parameters (N=2¹⁷, r=8, p=1), self-describing hashes so cost can be raised later without invalidating anyone, and `needsRehash` to report when a stored hash is behind policy.
- **`otpauth` for TOTP — the one new dependency.** Base32 codec, provisioning URI and drift window are ~100 lines of security-critical code that "a few lines" does not cover.
- **MFA secrets are AES-256-GCM, keyed by HKDF from `AUTH_SECRET`**, not a second environment variable. Anyone holding `AUTH_SECRET` can forge a session for any user and never has to defeat MFA, so a separate key buys nothing against that attacker — while deriving from a value that is not in the database still protects TOTP seeds against a database dump. **Rotating `AUTH_SECRET` forces every staff user to re-enrol**; documented in `.env.example`.
- **The second factor is a separate request carrying a single-use challenge token in an httpOnly cookie**, not the password resubmitted in a hidden field. A wrong code does not burn the challenge — the token is redeemed only after the factor verifies — because one typo sending a user back to the password screen is how people end up turning MFA off.
- **One `AuthToken` table for every short-lived token**, distinguished by `purpose`. Magic links, resets, MFA challenges and vendor links differ by purpose and subject, not by shape. D-9's lesson about parallel queues applies to parallel token stores. **R-025 should extend the `VENDOR_WORK_ORDER` metadata rather than inventing a `VendorLink` table.**
- **Tokens are stored as SHA-256 hashes, never plaintext.** A dump of `AuthToken` yields nothing clickable. Plain SHA-256 is correct rather than scrypt: these are 256-bit random values, so there is no dictionary to slow down.
- **No user enumeration anywhere.** Wrong password, unknown address, inactive account and locked account return one identical message; magic-link and reset requests return the same neutral notice whether or not the address exists — including when rate-limited, since a distinguishable "too many requests" would confirm which addresses are worth retrying. For a rental business a tenant list is a target list.
- **Account lockout is capped at an hour.** An uncapped lock is a denial-of-service an attacker triggers by failing someone's login on purpose.
- **No middleware.** Auth checks happen in server components. Prisma cannot run on the edge, and avoiding middleware avoids the whole edge-compatibility problem; R-004 and R-007 can revisit if a real need appears.

**What it left behind.**
- **Nothing is actually delivered.** `lib/auth/delivery.ts` is the seam; per CLAUDE.md, R-030 owns all sending and no module hand-rolls its own. Links are logged to the console in development and **deliberately dropped in production** — a live magic link in a log aggregator is a credential. **R-030** replaces the body of that one function.
- **`TenantCredential` exists but no tenant password flow is built.** The row supports an optional password (ROLE-05); magic link is the whole path today. Whichever item wants tenant passwords adds the provider — the table will not need changing.
- **Vendor links have a primitive but no page.** `issueVendorLink`/`redeemVendorLink` work and are tested; `/vendor/[token]` is **R-025**'s, along with scope, photo upload and the code-reveal audit event (**R-005**).
- **MFA is enrolled and verified but not *enforced*.** The session carries `mfaEnrolled` and `mfaVerified`; ROLE-05's "required before first privileged action" is an authorization rule and belongs to **R-004**, which owns what counts as privileged. Nothing in R-003 blocks on it.
- **No QR code on the enrolment screen** — the setup key is shown as selectable text, which every authenticator app accepts. A QR needs a rendering dependency for one screen used by three people; **R-007** can add it with the admin shell.
- **No TOTP replay guard.** A code stays valid for its 30-second step, so an intercepted code could be reused inside that window. Defeating it needs a store of recently-used (user, code) pairs. Not built: the exposure is 30 seconds against an attacker who already has the password and a live intercept, and **R-005**'s audit log is what would catch it.
- **`/account` and `/portal` are placeholders** that exist so sessions have somewhere to land. **R-007** builds the admin shell, **R-018** the tenant portal.
- **Rate limiting is a DB-backed fixed window**, marked with a `ponytail:` comment naming the ceiling. Exact enough to stop credential stuffing at this scale with no Redis; the core interface is the seam if it ever needs Upstash.
- `x-forwarded-for` is trusted for the rate-limit key. Correct behind Vercel, which rewrites it; **it would be spoofable behind an arbitrary reverse proxy**, and the comment in `actions.ts` says so.

**Bugs found along the way.**
- **The rate limiter did not limit anything under concurrency.** `SELECT ... FOR UPDATE` locks nothing when the row does not exist yet, so twenty simultaneous first attempts each concluded they were opening a fresh window and *all twenty were allowed* against a limit of five — the limiter failing open at exactly the moment it is under attack. Replaced with `pg_advisory_xact_lock(hashtext(key))`, which locks the key rather than a row. `_xact_` specifically, because Neon pools in transaction mode and a session lock would leak into the next request on that connection. Caught by a test written to look for this.
- **A mistyped MFA code threw out of the server action.** Auth.js reports *both* outcomes of `signIn()` by throwing — success throws Next's redirect, rejection throws `AuthError` — and only the redirect was being re-thrown. A wrong code replaced the sign-in form with an error page instead of a message. Now converted to form state, with the redirect still propagating.
- **`npm run test:e2e` never loaded `.env.local`.** The dev server got it through the root `dev` script, but the Playwright process itself had no `DATABASE_URL`, so any test touching the database failed. Root script now runs under `dotenv-cli` like every other.
- **`AUTH_URL` was not tied to the test port.** Auth.js builds its post-sign-in redirect from `AUTH_URL`, so running e2e on any port other than 3000 sent the browser to a different origin than the one under test and every sign-in failed with `ERR_CONNECTION_REFUSED`. `playwright.config.ts` now passes `AUTH_URL` alongside `PORT`.
