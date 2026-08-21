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
**Commit:** `62700de`  ·  **Date:** 2026-08-01

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

---

## R-004 — RBAC, scoping and monetary authority
**Commit:** `a371329`  ·  **Date:** 2026-08-01

**What it built.** Authorization. Six roles as seeded rows (`owner`, `manager`, `maintenance_tech`, `read_only`, `tenant`, `guarantor`), a `StaffAssignment` table that grants one role over one scope, per-user monetary ceilings, and the three functions D-5 names by hand — `can()`, `propertyScope()` and `checkMonetaryAuthority()` — in `packages/core/rbac`, none of them containing a bypass. `apps/web/lib/auth` turns a session into an `Actor` once per request and turns a scope into a Prisma `where` clause. 46 unit tests on the decisions, 14 integration tests proving the scope actually filters in Postgres, 12 e2e.

**What it decided.**
- **No superuser, enforced by a test that reads the source.** D-5 forbids a flag or a short-circuit, and no unit test can catch a bypass by calling the functions — a bypass makes the tests *pass*. So `rbac.test.ts` reads `can.ts` and `authority.ts` and fails if either contains `roleKey ===`, the literal `'owner'`, or anything matching `isSuperuser|isAdmin|isOwner`. The owner role is spelled out as the full permission list rather than a wildcard, because a wildcard is the same flag wearing a different hat.
- **The permission vocabulary is code; which role holds what is data.** 35 permission keys as a TypeScript union — a permission no `can()` call reads is a promise the product does not keep — while `Role.permissions` is a `String[]` column, so a role's contents can change without a release. No `Permission` table: it would only ever mirror the union with extra joins, and ROLE-07 puts a custom role builder out of scope.
- **MFA gates privileged actions only, and R-003's `mfaVerified` is where it lands.** The six permissions ROLE-03 calls privileged — `ledger.adjust`, `fee.waive`, `workorder.approve`, `staff.manage`, `document.delete`, `accesscode.reveal` — require a proved second factor. **Reads never do.** Locking a manager out of the rent roll for not having set up an authenticator is how MFA gets switched off by an irritated owner.
- **Denial reasons are ordered so the message is actionable.** Inactive first (a deactivated user fails identically for everything), then permission, then scope, then MFA. Checking MFA last means it only ever blocks someone who would otherwise have been allowed — so "enrol to continue" is true rather than a red herring.
- **`propertyScope()` returns `SCOPE_NONE` for a privileged permission without MFA.** Otherwise an un-enrolled owner gets `everything: true` and a list query hands back the whole portfolio that `can()` would have refused one row at a time.
- **An empty scope is `null`, not `{}`.** `propertyWhere()` returns `null` when the actor may see nothing, and callers must read that as "no rows". The two values are one keystroke apart and mean opposite things, so an empty scope is deliberately not representable as an object that could be spread into a query and vanish.
- **Scope is expressed by which column is set**, with a `CHECK` constraint rejecting rows that set both. An ambiguous scope means one reader sees a narrow grant and another sees a wide one; rejecting the row is cheaper than deciding which reader is right.
- **The live-grant unique index uses `COALESCE(col, '')`.** `NULL` never equals `NULL`, so a plain unique index would not constrain the portfolio-wide rows at all — which are exactly the most privileged ones. Partial on `revokedAt IS NULL` so revoked history does not collide with the grant that replaced it.
- **Ceilings fall back on `null`, never on falsiness.** Zero means "may approve nothing" and is a real setting; `||` would silently restore the role default. `null` means no ceiling configured, which reads as unlimited *only* for the owner — there is nobody above them to route up to — and every other role seeds an explicit number including an explicit zero.
- **Over-ceiling is an escalation, not an error.** MAINT-04 says a $650 estimate against a $500 ceiling *enters Pending Approval*; it does not fail. `checkMonetaryAuthority` returns `{outcome: 'escalate'}` and the return type is shaped so a caller cannot treat it as a boolean by accident. A zero ceiling denies outright instead, so a tech does not generate an approval request every time they open a work order.
- **The actor is loaded once per request via React `cache`**, never across requests. A revoked assignment stops granting on the very next request with nothing to invalidate — which is what makes ROLE-06 true for permissions as well as for sessions.
- **Query-shaping lives in `scope.ts`, apart from the session-reading guards.** Discovered while testing: `guard.ts` transitively imports next-auth, which cannot load under Vitest. The split is the right shape anyway — the where-clause builders are pure functions of a scope and now have real database tests.

**What it left behind.**
- **Nothing structurally forces a guard onto a new route.** There are three protected routes today and all are guarded, but "scoping on every endpoint" is a property a future page can silently break. **R-007** brings the admin shell and a real route tree; that is the moment to add a test that walks `app/` and asserts every page calls a guard. Noted rather than built, because a route-walking test over three routes proves nothing.
- **No UI for granting or revoking access.** `staff.manage` exists as a permission and the tables are there; the screen belongs with the admin shell (**R-007**), which also owns the `db:create-owner` bootstrap script per D-5.
- **Assignment changes are not yet audited.** A permission change is on ROLE-03's privileged list and `grantedByStaffId`/`grantedAt`/`revokedAt` capture the facts, but there is no `AuditLog` row — **R-005** owns the audit service and should write from here.
- **`accesscode.reveal` is a permission with nothing behind it yet.** The gate exists; the codes and the reveal log are **R-014**'s.
- **Guarantor actors cannot sign in.** The role and its permissions are seeded and tested, but no guarantor authentication path exists — R-003 built staff and tenant only. Whichever item first needs a guarantor in the portal adds it; `loadTenantActor` is the shape to copy.
- **Tenant scope is lease-only and property scope is empty for them by design.** A tenant has no property-level access even to the property their own home sits on, so tenant-facing list queries must filter by lease, not by `scopedByProperty`. **R-018** is the first consumer.
- **Seeded roles are rewritten on every deploy** (permissions and text, never ceilings). Correct while roles are system-owned; `Role.system` is the flag to branch on when that changes.

---

## R-005 — Append-only audit log service
**Commit:** `39b1969`  ·  **Date:** 2026-08-01

**What it built.** The shared audit service in `packages/core/audit`: a closed vocabulary of 26 actions and 12 reason codes, unconditional redaction of audit payloads, before/after diffing, a transaction-aware `recordAudit()` and an `auditTrailFor()` reader. `apps/web/lib/audit` resolves the current principal and request into an actor. Wired into every privileged action that exists today — assignment grant and revoke, MFA enrolment, password reset, sign-out-everywhere, successful sign-in, and lockout. 51 unit tests, 10 integration tests.

**What it decided.**
- **Redaction runs inside `recordAudit()` and cannot be opted out of.** The natural implementation of an audit log is `before: oldRow, after: newRow`, and the first time that runs over a `StaffCredential` update it copies a password hash and a decryptable MFA secret into a jsonb column — **in a table that is append-only by trigger, so it cannot be cleaned up afterwards.** Redaction is therefore not a courtesy applied at the call site.
- **Redaction is fail-safe by default with an explicit `ALWAYS_SAFE` allowlist.** Broad patterns catch anything matching `password|secret|token|credential|apikey|codes?$|ssn`; the only opt-out is a named line in the allowlist, so a new `gateCode` column is redacted until someone consciously exempts it. Deliberately **not** matching bare `hash`: `Document.sha256` proves a file was not swapped and is evidence, not a secret.
- **A sensitive field name redacts whatever it holds, object or not.** Recursing into a container named `credential` would leak a secret stored under a key the walker did not recognise; losing a couple of sibling fields is the cheaper mistake.
- **Redaction is by field name, never by sniffing values.** A value-based heuristic eventually redacts a rent amount that happens to look like a card number.
- **`recordAudit()` takes a Prisma client *or* a transaction client, and callers pass the transaction the action runs in.** The entry and the change are then atomic: the log can never claim something that did not happen, and a change can never happen unrecorded. Logging after the fact produces both failure modes, and the second one is silent.
- **Only what changed is stored, and `updatedAt` is dropped.** Whole-row snapshots duplicate the record into the audit table and turn "what changed?" into a diffing exercise for whoever reads it later — most likely in a courtroom. `updatedAt` changes on every write by definition and would bury the field that mattered in every single entry.
- **Actions and reason codes are closed vocabularies.** Free-text actions produce `lease.updated`, `lease.update` and `updateLease` in the same table within a year, and then "show me every change to this lease" needs a regex. Reason *codes* exist alongside free text because PAY-04 wants a waiver-pattern report by tenant for fair-housing consistency, and you cannot group by a paragraph.
- **Six actions cannot be recorded without a reason** and `recordAudit` throws rather than writing one. A waived late fee with no stated reason is indistinguishable from a favour; an entry-notice override with no reason is the fact pattern in an unlawful-entry claim.
- **`accesscode.revealed` audits a READ.** Most audit logs record only writes, and this one would otherwise miss the event that matters most in a break-in dispute (PROP-03). The gate exists now; **R-014** supplies the codes.
- **Individual failed logins are NOT audited; crossing into lockout is.** `AuditLog` is append-only and cannot be pruned, so auditing every wrong guess hands an attacker a way to fill the table. The rate limiter and `failedLoginCount` already bound and record the attempts.
- **Discovered, and correct: an audited staff user can never be deleted.** `AuditLog.actorStaffId` is a real foreign key, so deleting the user tries to null it, and the append-only trigger refuses the UPDATE. This is exactly what ROLE-06 asks for — deactivate and preserve history, never delete — now enforced by the database rather than by policy. The e2e cleanup was changed to deactivate audited test users instead of deleting them, because test rows are subject to the same rule.

**What it left behind.**
- **No audit-viewing UI.** `auditTrailFor()` is the reader and `audit.read` is a permission from R-004, but nothing renders it. **R-007** owns the shell; a per-record history panel belongs with the screens that show those records.
- **Entries are not property-scoped in practice.** `propertyId` is on the row and R-004's `scopedByProperty` will filter it, but almost every call site today is account-level and passes null. The items that audit property-scoped actions must set it, or a property-scoped manager reading the trail will see nothing.
- **`grantAssignment`/`revokeAssignment` have no caller.** They close R-004's audit gap and are the functions **R-007**'s access screen should call rather than writing `StaffAssignment` rows directly — the audit entry and the grant are one transaction here and would not be there.
- **Most of the action vocabulary has no producer yet** — `ledger.adjusted`, `fee.waived`, `workorder.approved`, `notice.served`, `inspection.locked`, `screening.decided`. Deliberate: the vocabulary is defined once so the items that add those features have somewhere to record to, rather than each inventing a string.
- **No retention or archival.** DOC-05 wants per-class retention, and an append-only table grows forever. **R-012** owns retention config; whatever it decides for audit entries has to work without UPDATE or DELETE, which likely means partitioning rather than pruning.
- The `auditAsSystem()` helper exists for jobs and webhooks but has no caller until **R-006**.

**Bugs found along the way.**
- **Four defects in redaction, all caught by tests written to look for them.** `resetToken` slipped through because `\btoken` needs a word boundary that camelCase does not provide; `smartLockCode` slipped through because `[^a-z]` is defeated by the `/i` flag; `postalCode`, `reasonCode` and `failureCode` would have been over-redacted by the broadened pattern. The schema-walking canary — which enumerates every field in the Prisma DMMF and asserts each suspicious name is either redacted or explicitly exempted — found the last of these and will keep finding them as the schema grows.
- **The typecheck gate broke on a file nobody wrote.** iCloud Drive resolves sync conflicts by writing `file 2.ts`, and `apps/web/tsconfig.json` excluded exactly that — but iCloud numbers conflicts upward and had reached `routes.d 3.ts`, which `tsc` then read as a duplicate `LayoutProps`. The exclude now uses a `?` wildcard rather than a literal `2`. Worth noting this is the second time this repo's lineage has lost time to iCloud conflict copies; the R-001 comment predicted the class of failure but pinned the digit.

---

## R-006 — Background jobs & event bus foundation
**Commit:** `1105b29`  ·  **Date:** 2026-08-01

**What it built.** The property-local scheduling primitive D-3 demands, a transactional event outbox with idempotent consumers, a scheduled-job runner, and the bearer-authenticated `/api/cron` endpoint the hourly Vercel Cron already pointed at. `packages/core/scheduling` is pure and has 23 tests covering both DST transitions; `apps/web/lib/jobs` has 14 integration tests against a real database; `e2e/cron.spec.ts` asserts the endpoint's authorization over real HTTP.

**What it decided.**
- **Jobs are DUE-BASED, not TICK-BASED.** This is the central decision and everything else follows from it. Asking "is the local hour exactly 2?" is wrong twice a year in both directions: on 2026-03-08 America/Chicago has **no 02:00 at all**, so the job silently never runs; on 2026-11-01 it has **two**, so the job runs twice and posts every charge twice. `isDue` therefore asks "**has** the local clock reached the target hour on today's local date?" — `>=`, not `===`. Both DST days are asserted in the tests.
- **The `>=` is made safe by a uniqueness constraint, not by narrowing the window.** `(jobType, propertyId, businessDate)` is unique, so "due for the rest of the day" still means one run. Together they also make a late tick, a missed tick, a cold start and a retry all self-correcting — the job catches up rather than being skipped.
- **`COALESCE(propertyId, '')` in that index, for the same reason R-004 needed it.** `NULL` never equals `NULL`, so a portfolio-wide job — the one that isn't per-property — would otherwise be completely unconstrained and could run on **every tick**. The most damaging case, not the least.
- **A business date is a `YYYY-MM-DD` string in core, not a `Date`.** A `Date` is an instant and "the 3rd in Houston" is not one. `businessDateToUtc` builds midnight **UTC** deliberately: constructing it from local midnight would land on the previous calendar day for every property west of Greenwich, reintroducing the exact bug at the storage boundary.
- **An unknown timezone throws rather than falling back to UTC.** A property with a garbage timezone would otherwise get every nightly job at the wrong hour, silently, forever. The runner reports it as a failed run instead of skipping the property.
- **The outbox is transactional: `emitEvent` takes the caller's transaction**, exactly as `recordAudit` does. An event written after commit is lost whenever the process dies in the gap, and lost silently.
- **Delivery is at-least-once plus idempotent consumers.** Exactly-once delivery does not exist. Each (event, consumer) pair runs in its own transaction *with* the `EventConsumption` row that records it, so a consumer that half-succeeded is retried rather than skipped, and one that already succeeded is never re-run when a sibling consumer fails.
- **A failing consumer does not block its siblings or the bus.** The event stays unpublished so the failure is retried up to 5 attempts, then falls out to `deadLetteredEvents`.
- **Events are facts in the past tense, never commands.** `lease.ended` belongs in the vocabulary; `send_move_out_email` does not. That is what lets R-030 and R-011 subscribe later without the emitter knowing they exist.
- **Payloads are a hint, not a source of truth.** They stay small and carry the aggregate id, because an at-least-once bus that ships full record snapshots eventually delivers a stale one to a consumer that acts on it.
- **`JobRun` is not a second work queue and does not violate D-9.** `Task` is the queue of work a *person* has to do; `JobRun` is the record of work a *machine* has done. A staff member never sees one. Said explicitly in the schema so a later reader does not have to guess.
- **A failed job run leaves its row behind.** The next tick sees the day as claimed, so a broken job fails once rather than sixty times before anyone notices. Retrying is a deliberate act.
- **The cron endpoint returns 404, not 401, to an unauthenticated caller**, and refuses everything when `CRON_SECRET` is unset. A missing environment variable in a new deployment must not become an unauthenticated endpoint that runs every scheduled job in the product on request.

**What it left behind.**
- **Both registries are empty**, and that is the deliverable. `SCHEDULED_JOBS` is filled by **R-010** (late-fee assessment), **R-030** (reminder ladder) and **R-040** (charge posting); `CONSUMERS` by **R-011** (task creation), **R-030** (notifications) and **R-034** (the Stripe projection). An empty registry is a working bus — events accumulate and are marked published, so nothing is lost while consumers are still being built.
- **The bus has a one-hour latency floor**, because it is polled from the hourly cron. Fine for nightly work, **not fine for an emergency maintenance page** — **R-029** must route those directly rather than through the outbox. Marked with a `ponytail:` comment.
- **A job targeted at a late local hour is skipped, not caught up, if the cron is down through that hour** — `businessDate` has already rolled over by the next tick. Acceptable while the jobs that matter target early hours; the fix, if a late-day job ever matters, is for `runDueJobs` to also look back one business date. Marked with a `ponytail:` comment.
- **No dead-letter UI.** `deadLetteredEvents()` is the query; **R-007**'s shell is where it belongs.
- **No `day.rolled_over` emitter.** The event name exists for a job that wants to fan out per property without re-deriving the local date; nothing emits it yet.
- Properties are processed **sequentially**. Correct for 10–50 units against a pooled Neon connection; revisit only if a portfolio grows enough for the cron to approach its 60s ceiling.

**Bugs found along the way.**
- **The job tests ran real jobs against other test files' properties.** `runDueJobs` iterates every active property by design, and vitest runs files in parallel — so `JobRun` rows were created against the RBAC scoping tests' fixtures, whose `afterAll` then failed on a foreign-key constraint it could not satisfy. Fixed by giving `runDueJobs` an optional `propertyIds` filter, which is also a real operator capability: backfilling one property after a fix. The failure only appeared in the full suite, never when the file ran alone.
- **Two of my own test expectations were wrong, and the implementation was right.** A job at hour 2 is *not* due at local midnight (the target hour has not arrived), and a Honolulu property legitimately runs **twice** across three UTC ticks because its local day rolls over mid-sequence. Both now assert the correct behaviour with the reasoning written down — the second is a small demonstration of why D-3 exists at all.
- **One rate-limit test was quietly exceeding vitest's 5s default under full-suite load.** Twenty transactions serialized behind an advisory lock, each a round trip to a hosted database, competing with the rest of the suite for the pool. Given a real timeout rather than left to flake. A stale comment crediting `SELECT ... FOR UPDATE` — the approach that did *not* fix the R-003 concurrency bug — was corrected at the same time.

---

## R-007 — Admin shell
**Commit:** `da14b98`  ·  **Date:** 2026-08-01

**What it built.** The staff shell everything later renders inside: skip link, header with property switcher and universal search, permission-filtered left nav, and six section routes that each guard themselves. Plus `db:create-owner`, the D-5 bootstrap that gives a new deployment its first human, and the route-guard test R-004 deferred until there was a tree worth walking. 24 shell e2e tests, 12 route-guard tests.

**What it decided.**
- **`db:create-owner` does not create a superuser, because there is no such thing (D-5).** It creates an ordinary `StaffUser` and an ordinary `StaffAssignment` with `roleKey=owner` and a null scope — grantable, revocable, and audited like any other grant. It refuses a second owner without `--force`, refuses an existing email outright, and prints a single-use setup link rather than a password.
- **The bootstrapped account gets a random password nobody ever holds.** That keeps it out of a "no credential" state, so the ordinary reset flow works unchanged and there is no special first-login path to get wrong. The setup link is the only way in.
- **The audit entry for the bootstrap is attributed to `SYSTEM: db:create-owner`.** It is the one grant in the system with no human grantor, and the trail should say so plainly rather than pretend otherwise.
- **The layout guard is a floor, not a ceiling.** `requireStaff()` in `(admin)/layout.tsx` proves the visitor is staff and nothing more; every page still asserts its own permission, because a layout cannot know what the page below it is about to show. ROLE-01 is explicit that this is per role *and record scope*.
- **The nav is filtered on the server**, so a maintenance tech is never sent the markup for a financial section. Hiding a link is not authorization, though — the same tech typing `/money` is refused by the route, and that is what the e2e asserts.
- **An authorization failure is a redirect, not an exception.** Discovered while testing: `requirePermission` threw, nothing caught it, and a tech opening a financial link got Next's *"This page couldn't load"* crash page. A permission boundary is an ordinary, expected outcome, so denials now redirect to `/no-access`, which names the missing permission so the person can ask for the right thing. `mfa_required` still goes to enrolment, because that user *is* allowed and only needs to prove a second factor.
- **The property switcher is a filter, never a grant.** The cookie is a preference; `currentScope` intersects it with `propertyScope()` on every request, so a selection left over from before an assignment was revoked narrows the view and can never widen it. `selectScope` deliberately does no validation — validating there would imply the cookie is trusted somewhere, which is the belief that turns a filter into an escalation path.
- **A native `<select>`, not a custom combobox.** Keyboard-accessible and screen-reader-correct with no work, right on a phone, and a 10–50 unit portfolio does not need type-ahead. A shadcn Select would need roving focus, escape handling and an aria pattern to match what the browser already does.
- **Sign-in lands on `/dashboard`**, not `/account`. `/account` moved inside the shell so it is reachable from the header on every screen — it owns MFA enrolment, which every privileged action depends on.
- **Section placeholders name their owning backlog item.** A half-built product that explains itself is better than one that looks broken, and it stops someone wiring a second version of a section by accident.
- **The route-guard test walks `app/` and fails the build on an unguarded page**, with a `PUBLIC_ROUTES` map where each exemption carries its reason. Verified by planting an unguarded page and watching it fail. This is the R-004 deferral, now worth writing: a missing guard is invisible in a diff that adds a hundred lines of JSX, and the only symptom is the wrong person reading a page.

**What it left behind.**
- **The six sections are placeholders.** Each names its owner: **R-013** dashboard, **R-008** properties, **R-016** leases, **R-022** maintenance, **R-035** money, **R-011** tasks.
- **Universal search is a stub with a real route.** Nothing is indexed. Whichever item builds the index must scope every result through R-004 — search is the classic place a property-scoped manager sees a lease from a property they cannot access, because the result set was assembled before anyone thought about scope. The stub says so on the page.
- **No access-management UI**, so `grantAssignment`/`revokeAssignment` from R-005 still have no caller. Not in this row; whichever item builds the staff screen should call them rather than writing `StaffAssignment` rows directly.
- **The switcher selection does not reach any query yet**, because no section runs one. `currentScope(actor).propertyIds` is the value sections consume, and the placeholders display it so the plumbing is visibly working.
- `/` is still R-001's placeholder. **R-013** replaces it; the smoke test still asserts its heading.
- No dark-mode toggle, no breadcrumb, no collapsible nav. The theme tokens support dark mode and it is untested; polish belongs with the screens that need it.

**Bugs found along the way.**
- **TypeScript parameter properties broke every CLI script.** `constructor(readonly action: AuditAction)` is valid TypeScript that Node's strip-only mode cannot execute — stripping the type leaves nothing to perform the implied assignment, and it fails at *import* time. R-005's `MissingAuditReasonError` and R-006's `UnknownTimezoneError` both used the form, so `db:create-owner` crashed before doing anything the moment it imported the audit service. Next compiles these files properly, which is why nothing had noticed. All three classes in the repo now declare and assign fields explicitly; the rule is repo-wide rather than per-file, because remembering which modules are reachable from a script is a worse bet than one convention.
- **An authorization denial rendered a 500 crash page** — see the redirect decision above. Found by asserting on the status code rather than trusting that "it refuses" was good enough.
- **Two e2e locators became ambiguous** once the shell rendered "All properties" in the switcher alongside the account page's "Owner — all properties", and one test's `Tab` press was measuring focus left over from the sign-in click rather than a fresh page. Both were test defects, not product ones.

---

## R-008 — LegalEntity + Property CRUD
**Commit:** `878c72c`  ·  **Date:** 2026-08-02

**What it built.** Full create/read/update for `LegalEntity` and `Property` (both modeled in R-002, untouched by this item — no migration). `packages/core/property` validates addresses, US state codes, IANA timezones and the rest of the property fields by hand, matching `packages/core/auth/password.ts`'s style rather than pulling in a schema library. The Properties list, an owning-entity-scoped create/edit flow for both models, a property detail page with PROP-01's five empty-state sections, and a duplicate-address warning that stops a second record rather than silently creating or silently blocking one. 36 core tests, 10 query-scoping integration tests, 34 e2e tests.

**What it decided.**
- **No geocoding adapter.** PROP-01 asks for an address "validated/geocoded", and this delivers real structural validation plus duplicate-detection but leaves `Property.latitude`/`longitude` null. Nothing downstream in the backlog reads them yet (no map view, no distance calc), and the PRD's integrations section names a vendor for Stripe, Resend and Twilio but not for geocoding — building a `SimulatedGeocodeAdapter` in D-7's style for a field with zero consumers would be exactly the speculative infrastructure this codebase's conventions warn against. Whichever item first needs real coordinates picks a provider then.
- **Duplicate detection is a hand-rolled comparison key, not a geocoding-grade address matcher.** Case, punctuation and a small set of common street-suffix/direction words are folded (`Street`→`st`, `North`→`n`) and compared against the ZIP-5 — enough to catch the realistic case (the same person re-typing the same address slightly differently), not a claim of general address-matching. The check is scoped to what the actor can already **read**, never the whole portfolio: a wider check would leak the existence of properties outside their scope through the warning message itself.
- **The duplicate warning stops and asks; it never silently blocks.** A second unit built at the same street address is a real, legitimate case, so "Save anyway" resubmits with `confirmDuplicate=true` rather than the product refusing outright.
- **Discovered and fixed: a bare `requirePermission(permission)` with no resource has been silently denying every entity- and property-scoped actor since R-007.** Per `can()`'s `assignmentCovers`, an empty resource only ever matches a **portfolio-wide** grant — an entity-scoped manager's `resource.legalEntityId === assignment.legalEntityId` check fails against `undefined`. R-007's own section placeholders all used this bare form and it shipped dormant, because R-007's tests only ever exercised portfolio-wide roles. R-008's own list and detail pages inherited the same bug, and its more pointed scoping tests (a property-scoped manager reading `/properties`) caught it immediately. Fixed with a new primitive, `requireScope(permission)`, added to `guard.ts`: it checks "does this actor hold `permission` over **anything**" (an empty `PropertyScope`) rather than over one specific, absent resource, and is now what every scoped list/detail page should use instead of a bare `requirePermission`. `/properties`, `/properties/[id]` and `/properties/new` all use it. **The other four section placeholders (leases, maintenance, money, tasks) still carry the original bug** — left alone because rewriting a placeholder outside R-008's remit for a real list view nobody has designed yet would be presumptuous, but the item that builds each one should reach for `requireScope`, not repeat R-007's mistake.
- **Creating a property has no `propertyId` yet, so a property-scoped manager cannot create one anywhere, ever — not even under their own property's entity.** This is a direct, correct consequence of R-004's resource-matching rules, confirmed by both a unit test on `listWritableLegalEntities` and an e2e test. Only a portfolio-wide or entity-scoped `property.write` grant clears that bar. An entity-scoped manager *can* create under their own entity, and the entity dropdown on `/properties/new` is scoped to exactly that — the **write** scope, deliberately distinct from the read scope the switcher uses.
- **Discovered and fixed: React resets an uncontrolled `<form>`'s fields after every action dispatch — success or failure — not just on success.** The duplicate-warning flow depends on the user's typed values surviving a round-trip so "Save anyway" can resubmit them; instead every field (including the required address) was silently wiped the moment the first response came back, so "Save anyway" submitted an empty form that failed native `required` validation and never actually reached the server a second time. Fixed by having the action echo back what was submitted (`PropertyFormState.submitted`) and giving the `<form>` a version-counter `key` that bumps when a new state arrives — computed **during render**, not in a `useEffect`, per React's own guidance for this exact pattern and to avoid `react-hooks/set-state-in-effect`'s cascading-render warning. The same fix covers ordinary validation failures on both create and edit, which had the identical silent-data-loss bug — just never observed, because no existing test checked whether a field's value survived a failed submission.
- **`Property`'s audit rows extend R-005/R-007's undeletable-once-audited lesson one level further.** `AuditLog.propertyId` is a real foreign key (unlike `entityId`/`entityType`, which are plain descriptive strings with no FK). A property that went through the real `createProperty`/`updateProperty` action therefore cannot be hard-deleted — the same append-only trigger that protects `StaffUser` now protects `Property` too. Test cleanup deactivates audited properties instead (mirroring R-007's staff-user pattern), and — new this time — an owning `LegalEntity` can only be deleted once **no** property still references it, including the ones just deactivated rather than removed.
- **The account/switcher naming collision from R-007 (`currentScope` exported by both `guard.ts` and `lib/scope/current-scope.ts`, meaning two different things) was not fixed, only carefully aliased at each new call site** (`switcherScope`, or destructuring only what's needed). Renaming either existing export was judged out of scope for a CRUD item; noted here so the next session does not reintroduce the ambiguity by importing both unaliased in one file.

**What it left behind.**
- **Units, Leases, Maintenance, Documents and Financials are empty-state sections on the property detail page**, per PROP-01's own acceptance criterion ("empty states OK") — owned by R-009, R-016, R-022, R-012 and R-035 respectively.
- **No property deactivation/archival UI**, though `Property.active` already exists and is exactly what the duplicate-check and list queries filter on. Nothing in PROP-01/PROP-04 asked for it; whichever item wants "retire a property without losing history" adds the screen.
- **`requireScope` exists but only three of R-008's own pages use it.** The four other section placeholders (leases, maintenance, money, tasks) still carry the dormant bare-`requirePermission` bug described above — flagged, not fixed, since fixing a placeholder for a screen nobody has designed yet risks guessing wrong about what that item actually needs.
- **The property-switcher naming collision is unresolved**, see above.
- **No bulk import, no CSV, no map view.** A 10–50 unit portfolio is created by hand through this form; nothing in PROP-01/04 asked for more.

**Bugs found along the way.**
- **The `requirePermission`-with-no-resource bug**, described above in full — the most consequential finding in this item, since it was silently shipping in R-007 and would have kept shipping in every future scoped list page that copied the same (wrong) pattern.
- **The React form-reset-after-action-dispatch bug**, also described above — silent data loss on every validation failure and on the duplicate-warning path specifically, fixed with the version-keyed remount.
- **A one-off flaky e2e assertion, diagnosed and fixed as a test-infrastructure issue, not a product bug.** The duplicate-confirm test occasionally found `null` querying for the just-created property immediately after the page's own redirect had already rendered it correctly — proven, by direct comparison, to be a read-after-write visibility gap specific to the **test's** separate Prisma connection against Neon's pooled backend, not the app's (the server-rendered detail page, using its own connection, was instantly consistent every time). Fixed by polling the test's assertion (`expect.poll`) rather than reading once; confirmed with a 5-way parallel repeat run after the fix, 0 failures.
- **Two rounds of stray test data self-inflicted during this session's debugging** polluted the shared dev database and produced misleading failures in *later* test runs — the exact mechanism the R-008 duplicate-detection feature is designed to catch, now observed catching the author's own leftover rows. Cleaned up by hand; the underlying fix (test addresses now include a random street number rather than a fixed string) prevents recurrence.

---

## R-009 — Unit management
**Commit:** `2c628e6`  ·  **Date:** 2026-08-03

**What it built.** Full create/read/update for `Unit` (modeled in R-002, untouched here — no migration), plus PROP-02's one automated rule: a scheduled job that flips a unit to `MAKE_READY` once its lease has ended without a renewal in place. This is the first item to register a real job into R-006's `SCHEDULED_JOBS`, so it also builds the registration convention R-006 left for "the items that own the nightly work" — a single `apps/web/lib/jobs/registrations.ts` that side-effect-imports every job module, which the cron route now imports instead of expecting jobs to appear on their own. 20 core validation tests, 15 job/query integration tests, 18 e2e tests — plus two real bugs found and fixed in already-shipped R-008 code, and one in R-003's, described below.

**What it decided.**
- **No restricted status-transition matrix.** PROP-02 does not ask for one, and inventing rules like "OCCUPIED cannot go straight to DOWN" would be actively wrong — a pipe can burst in an occupied unit. Status is a plain field staff can set to anything; the one AUTOMATED transition is the job described below.
- **"Ends without renewal" is read narrowly and mechanically: a successor lease already exists for the same unit.** Any lease in a state that means "this is going to happen or is happening" (`DRAFT`, `PENDING_SIGNATURE`, `ACTIVE`, `MONTH_TO_MONTH`) starting on or after the ending lease's end date counts as a renewal, and the job leaves the unit alone. R-033 (lease records) has not been built yet, so this is exercised entirely against directly-seeded `Lease` rows — the same position R-006's own job tests took before any real consumer of the job runner existed.
- **The job only touches `Unit.status`, never `Lease.status`.** PROP-02's acceptance criterion is specifically about the unit; leaving a lease's own status machine (pending/active/notice-given/ended) untouched is deliberate, since R-033 owns that state machine and hasn't decided its shape yet. The unit-status check (`unit.status = OCCUPIED`) already provides the job's idempotency without needing to also close out the lease.
- **The job emits `unit.became_make_ready` (a new domain event) and writes an audit entry, attributed to `SYSTEM`.** Neither is strictly required by ROLE-03's privileged-action list, but "why is this unit marked make-ready" is an entirely ordinary question an owner-operator will ask months later, and R-006 built the event bus and the audit service specifically so a job like this would not have to invent its own answer. No consumer subscribes to the event yet — R-011's task queue and R-030's notifications are the natural ones, whenever they exist.
- **Established the job-registration pattern R-006 left open.** `SCHEDULED_JOBS` and `CONSUMERS` are plain mutable arrays that job/consumer modules push into on import; nothing was populating them until a module actually got imported somewhere in the running app. `apps/web/lib/jobs/registrations.ts` is now the one place that imports every job module for that side effect, and the cron route imports it instead of `runner.ts` alone. Importing a job module from anywhere else would register it a second time under a different module instance — invisible until the job runs twice a tick.
- **The auto-transition job calls `recordAudit` from `packages/core/audit` directly, not the app-layer `auditAsSystem()` wrapper.** That wrapper's whole purpose is resolving the *current request's* actor, which requires importing `auth.ts` (Auth.js) — irrelevant for a background job, whose actor is unconditionally `SYSTEM`, and which has no request. Discovered because this is the first job with its own dedicated Vitest test that imports the job module directly; the cron route itself was never affected, since it only runs in the real Next.js runtime.

**What it left behind.**
- **No vacancy board.** PROP-02 mentions a unit "appears on the vacancy board" once it auto-transitions; no such board exists (nor does a dashboard at all — R-013 owns that). A future vacancy view is a query for `status: MAKE_READY`, nothing more; the data side is already correct.
- **Operational data, lease and maintenance sections on the unit detail page are empty states**, same convention as the property detail page: owned by R-014, R-033 and R-022 respectively.
- **No unit deactivation/archival.** `Unit` has no `active` column (unlike `Property`), and PROP-02 did not ask for one.
- **The unit form loses typed values on a validation failure**, same as R-008's `EntityForm` and for the same reason (React resets uncontrolled fields after any action dispatch — see R-008's entry). Not fixed here: seven short fields with no multi-step confirmation flow, the same size/shape judgment call R-008 made for the entity form specifically, not the ten-field property form with its duplicate-warning flow.

**Bugs found along the way.**
- **A real, currently-shipped scoping bug in R-008: `requirePermission('property.write', { propertyId })` denied an entity-scoped manager editing a property that genuinely belongs to their own entity.** `can()`'s `assignmentCovers` picks one branch per assignment shape — a property-scoped grant is checked against `resource.propertyId`, an entity-scoped grant against `resource.legalEntityId` — and never falls back from one to the other. Passing only `propertyId` therefore silently excludes every entity-scoped grant. Found while working out the correct resource shape for unit permission checks, which scope through a property the same way. Fixed with a new shared primitive, `propertyResource()` in `guard.ts`, which supplies both ids; applied to the property edit page, its Edit-button visibility check, and the `updateProperty` action — all three were affected, none of the *read* paths were (R-008's own `requireScope` fix already handled those). A regression test (an entity-scoped manager editing a property in their entity) now covers it directly.
- **The route-guard test only recognized `requirePermission(` as a valid guard call, so it had been passing R-008's own `requireScope()`-guarded pages for the wrong reason** — their explanatory comments happened to also contain the literal string `requirePermission(` while describing why *not* to use it, which was enough to satisfy the test's naive substring match. The new unit detail page, whose comment doesn't mention that string, caught the gap for real. Fixed by adding `requireScope(` to the test's recognized guard calls; re-verified the gate still fails on a genuinely unguarded page.
- **A pre-existing R-003 test (20 concurrent rate-limit attempts) was failing consistently, not just flaking, by the time this item's testing was done** — Prisma's default 5-second interactive-transaction timeout, measured from when a transaction *starts*, includes time spent queued behind the advisory lock the test is specifically designed to serialize every caller through. Under today's latency the 20th caller in that queue no longer reliably finished within 5 seconds. Fixed by raising `consumeRateLimit`'s transaction timeout to 15 seconds — a change to how long a rare, adversarial pile-up is allowed to queue before giving up, not to any ordinary, uncontended request.

## R-010 — JurisdictionRule engine
**Commit:** `54f632b`  ·  **Date:** 2026-08-03

**What it built.** The resolver every later item routes statutory numbers through: `rulesFor(property, asOf)`, backed by a pure `selectApplicableRule()` in `packages/core/jurisdiction` that picks the right version of the right (state, jurisdiction) row for a given day, plus a hand-rolled `validateJurisdictionRule()` covering all twenty-odd fields (late-fee consistency by type, deposit/notice ranges, a closed payment-allocation-order vocabulary). Texas is seeded statewide, version 1, unreviewed. A small portfolio-wide admin section (`/jurisdiction`, `/jurisdiction/new`) lists what's currently in force and lets an owner add a new effective-dated version, prefilled from whatever it replaces. 24 core tests, 7 query integration tests, 8 e2e tests.

**What it decided.**
- **A local ordinance is a full config row, never a diff against the statewide one.** `jurisdiction` (city/county) is null for statewide or a name for a local override; `selectApplicableRule()` picks whichever ONE row governs a given day, preferring a local row only while it is genuinely in force and falling back to statewide the moment it isn't (not yet effective, or repealed) — never merging fields across the two. Matches D-4's own framing: "adding a jurisdiction = adding a reviewed config record", not a patch.
- **Versions are never edited or deleted, only added.** `createRuleVersion()` has exactly one shape: look up whatever is currently open-ended for a (state, jurisdiction) pair, close its `effectiveTo` to the day before the new version's `effectiveFrom`, and insert the new row. There is no update action and the schema has no soft-delete column for this entity — the version history *is* the audit trail, on top of the AuditLog entry (`jurisdiction_rule.versioned`) each write also records.
- **`jurisdiction.read`/`jurisdiction.write` are portfolio-wide-only permissions, not property- or entity-scoped.** A JurisdictionRule applies by state, not by property or legal entity, so there is no scoped resource to check it against — `requirePermission('jurisdiction.write')` with no resource is the deliberate guard, per R-004's `can()`: an empty resource only ever clears for a portfolio-wide grant. `manager` and `read_only` were given `jurisdiction.read` (they need to explain a fee to a tenant); only `owner` gets `jurisdiction.write` (a config change is a legal release gate, not routine portfolio work). A consequence, left as a known gap: an entity- or property-scoped manager cannot see jurisdiction rules at all, even for a state their own properties sit in — real for this operator size (a 10–50 unit single-owner-operator's manager is typically portfolio-wide anyway), not solved here.
- **`reviewedBy` is a visible badge, not a code-enforced gate.** The decisions doc is explicit that legal review per config is a release-gate *process* requirement no code check can substitute for, so the seeded Texas row ships with `reviewedBy: null` and the admin list marks it "unreviewed" rather than blocking the resolver from using it — blocking would make the seeded default useless for every other item that needs a real number to build against.
- **Payment-allocation order is a fixed-order checklist, not a reorderable list.** The form presents the non-deposit, non-concession charge types in one canonical sequence (rent first) and lets an admin choose which are included; no jurisdiction in the current footprint needs a genuinely different sequence (fees before rent, say), so a real drag-reorder control was not built.
- **Money and percent fields are typed as whole dollars and whole percent in the form, converted to cents/basis-points once at the write boundary** — the same pattern R-009 used for market rent, extended to five fields here (flat/daily/max fee amounts, deposit and late-fee-cap percentages, application-fee cap).

**What it left behind.**
- **Only Texas is seeded.** Every other state is a real, un-configured gap (OQ-1) — `rulesFor()` throws `JurisdictionRuleNotFoundError` rather than silently applying no fees or notice rules, so the gap fails loudly the first time a property outside the footprint needs a number, instead of manufacturing a compliance failure.
- **No history page beyond the current-version list.** Old versions are queryable (`listRuleVersions()`) and kept forever, but there is no dedicated UI for them yet — a small addition whenever someone actually needs to see what a rule looked like two versions ago.
- **Nothing consumes the resolver yet.** `Charge` and `Notice` already carry a `jurisdictionRuleId` FK from R-002, but nothing populates it until R-035 (ledger/money rules), R-040 (late fees), R-041 (deposits) and R-051 (notice delivery) exist to call `rulesFor()` for real.
- **Entity- and property-scoped managers cannot read jurisdiction rules at all**, per the portfolio-wide-only decision above — a real narrowing, not an oversight, and flagged there rather than repeated here.

**Bugs found along the way.**
- **A client component importing a runtime Prisma enum crashed the browser bundle.** `rule-form.tsx` (`'use client'`) imports `PAYMENT_ALLOCATION_CHARGE_TYPES` from `packages/core/jurisdiction`, and that module's original `import { ChargeType, LateFeeType } from '@rental/db'` was a VALUE import, not a type-only one — unlike `packages/core/audit/record.ts`'s identical-looking `import type` of Prisma types, which is erased at compile time and therefore never reachable from a client bundle. The value import pulled the whole generated Prisma client — which does `require('fs')` — into the browser, and every page after the first `/jurisdiction/new` visit in a test run hung forever waiting on a webpack module-resolution error, taking the rest of that run's tests down with it (a genuinely confusing failure: unrelated tests further down the file kept timing out on `/login`, which was itself unaffected — the shared dev server had wedged). Fixed by switching to `import type` and hand-declaring the enum values as literal arrays checked against the real type with `satisfies`, matching the existing convention in `packages/core/property/validate.ts` and `packages/core/units/validate.ts` (both already avoid a runtime Prisma import for exactly this reason, which this item should have followed from the start instead of rediscovering).
- **Prisma's generated compound-unique-input type cannot address a row through a nullable column in the key**, even though Postgres's own unique index has no trouble with it. `JurisdictionRuleStateJurisdictionVersionCompoundUniqueInput` types `jurisdiction` as `string`, not `string | null`, so `prisma.jurisdictionRule.upsert({ where: { state_jurisdiction_version: { jurisdiction: null, ... } } })` fails to typecheck for the statewide seed row. Worked around in the seed script with a plain find-then-create instead of `upsert` — idempotent all the same, and arguably clearer about intent (this only ever creates; D-4 already forbids rewriting an existing version's values).

## R-011 — Task queue
**Commit:** `30d9aa3`  ·  **Date:** 2026-08-03

**What it built.** The one work queue every later staff-facing queue is a view over (D-9): `createTask()`, an idempotent primitive keyed on the schema's own `(type, subjectId, businessDate)` unique index (create-then-catch-P2002, the same pattern R-006's job runner already uses for `JobRun`); a "my day" list (assigned to me or unclaimed, due today or overdue, sorted emergency-first) and a per-property portfolio roll-up, both scoped the same way R-008's property list and R-009's unit queries are; claim/complete/cancel actions; and one staff-initiated way to create a task with no domain event behind it - an "Add task" form, for the ad-hoc "check the smoke detector batteries" case nothing else covers. This is the first item built with **zero real producers** - R-011 exists precisely so R-023, R-030, R-054, R-072, R-073 and R-077 all read and write the same table instead of each inventing its own, and none of them exist yet. 9 core tests, 15 create/query integration tests, 10 e2e tests.

**What it decided.**
- **`PROOF_REQUIRED_TASK_TYPES` and `AUDITED_TASK_TYPES` start empty, on purpose.** The backlog asks for "proof-gated completion" and "audit on sensitive types," but there is no real task type yet to gate or audit - Task.type is free-form specifically so a later item can introduce one without a migration (R-002's own schema comment). Both are closed, code-owned registries a future item populates when it introduces a type that needs one, matching `packages/core/rbac`'s `PRIVILEGED_PERMISSIONS` and `packages/core/audit`'s `REASON_REQUIRED` - "a flag no check ever reads is a promise the product does not keep." Every completion today is therefore un-gated and un-audited beyond the Task row's own `completedByStaffId`/`completedAt`, which is itself a permanent record, just not one that shows up in `auditTrailFor()`. Both functions accept the registry as a parameter (defaulting to the real one) specifically so this item's own tests could prove the mechanism works against a synthetic type, the same way R-006's job-runner tests exercise the runner against a fake job that is never registered for real.
- **Completion is open to anyone holding `task.write` on the property, not gated to whoever claimed it.** Claiming exists so two people do not duplicate effort on the same task, not as an exclusive lock on who may finish it - a manager completing a job a tech reported done by phone is normal, not a workaround. `claimTask()` alone refuses to hand an already-claimed task to a second claimant.
- **A manual "add task" mints a fresh, random `subjectId` rather than going through `createTask()`'s idempotent path.** Idempotency exists to protect against an automated producer's domain event firing twice; a human clicking "Add task" twice means two distinct tasks, never a silent no-op. Using the SAME idempotency key shape (`type: 'ad_hoc'`, `subjectId: <property id>`) would have silently collapsed every ad-hoc task added for one property on one day into a single row - caught while designing the manual-add path, before it shipped.
- **`completedByStaffId`/`completedAt` are reused for the cancel path rather than adding a second pair of columns.** The schema has no `canceledBy`/`canceledAt`, and "who closed this out, and when" is the same useful fact whether the task was finished or abandoned; a `Task` is either done or it was not worth doing.
- **"My day" evaluates "today" per property, not globally**, for the same D-3 reason R-006's job runner does: a portfolio spanning timezones would show a Pacific property's tasks a few hours early or hide a Central property's overdue ones a few hours late, right at the boundary, if "today" were computed once for the whole request.

**What it left behind.**
- **No real producer exists yet.** Every task in this build is either seeded directly in a test or added by hand through the new form. R-023 (triage), R-030 (verify & close), R-054 (bounced messages), R-072 (turnover), R-073 (inspections) and R-077 (compliance calendar) are the items that call `createTask()` for real.
- **No bulk actions**, despite the master PRD naming them as something Marisol (the PM/assistant persona) explicitly wants. The backlog line for R-011 does not ask for them, and a one-at-a-time queue is the smaller thing that works until a real multi-select need shows up.
- **No reassignment.** A claimed task can be completed or canceled by anyone with `task.write` on the property, but there is no "hand this to someone else" action - only claim (from unassigned) and the two resolutions.
- **Entity- and property-scoped actors were exercised for read/write/claim, but the "Add task" property picker draws from the actor's `property.read` scope, not a `task.write`-specific one.** In practice every role holding `task.write` also holds `property.read` at the same scope, so this has never shown a property the actor could not actually write a task to - but it is a coupling assumption, not an enforced one, and the real check still happens in `addTask()` itself when the property is submitted.

**Bugs found along the way.**
- **A near-miss on this item's own list page: `actorCan('task.write')` with no resource was the first draft's check for showing the "Add task" link.** Per R-004's `can()`, a resource-less check only ever clears for a portfolio-wide grant - the exact dormant-bug class R-008 found on the old placeholder pages and R-010 nearly reintroduced for jurisdiction rules, except here `task.write` genuinely IS property-scoped (unlike `jurisdiction.write`), so this would have hidden the "Add task" button from every property- and entity-scoped manager and tech, despite `unit.write`-style checks elsewhere in the codebase already having fixed the identical shape twice. Caught before shipping, not after, by checking against `propertyScope('task.write')`/`scopeIsEmpty()` instead - the same primitive `requireScope()` already wraps for guards.

## R-012 — Document & photo store
**Commit:** `07bee70`  ·  **Date:** 2026-08-04

**What it built.** Attach/find/version/soft-delete for `Document` (DOC-01, DOC-05) and the per-unit photo library (PROP-08): a `StorageAdapter` interface (D-14) backed by local disk in dev/test, EXIF `capturedAt` extraction that is preserved distinct from `createdAt` and never overwrites/strips the original, a closed `DOCUMENT_TYPES` vocabulary with a per-class `RETENTION_RULES` config (`retentionCutoff()` + a `documentsPastRetention()` report - not an automated purge), a `deletedAt` soft-delete column (new migration) with a reason-coded delete and an MFA-gated restore, and a `DocumentsSection` embedded on both the property and unit detail pages. Only Property and Unit are real attachment targets today - Lease, Tenant, Vendor, Ticket and WorkOrder all have their own column on `Document` already (R-002) but no CRUD of their own yet to attach to for real, the same "built before some of its consumers" situation R-011 shipped. 10 core tests, 4 EXIF tests (mocked - no real JPEG fixture needed to prove the wrapping logic), 5 local-storage-adapter tests, 8 query integration tests, 7 e2e tests, on both viewport projects.

**What it decided.**
- **D-14: a `StorageAdapter` interface, local disk in dev/test, a real object store (Vercel Blob/S3-class) a same-interface swap later.** Recorded as a new decision (not silently resolved) because it is a genuine architecture choice with consequences beyond this item: unlike D-7's simulated adapters (which fake a partner-gated, regulated API this build has no relationship with), file storage is commodity infrastructure this product can run for real against disk today - the swap being deferred is a deployment concern, not a missing capability.
- **Retention rules are computed from `createdAt`, not the more precise post-termination/post-decision reference points DOC-05 actually describes.** Lease termination dates and screening-decision dates belong to workflows this build has not reached (R-033, R-060+); `createdAt` is the conservative approximation available today, and it only ever UNDER-counts elapsed time - erring toward keeping evidence longer, never toward purging it early.
- **Retention is a report, not an automated purge.** `documentsPastRetention()` surfaces what is eligible for review; nothing deletes on a schedule. Irreversibly destroying a document is exactly the kind of automated action the master PRD's own §6.8 principle ("every automated action has a visible log and an easy reverse") argues against doing silently, more so than any other automation this build has shipped.
- **`DOCUMENT_TYPES` is a closed vocabulary, unlike `Task.type`'s free-form string.** The schema's own comment says this field "drives the retention rules R-012 configures" - a retention rule keyed by an unrecognised type is a retention rule silently never applied, so the type has to be a value the code actually knows about, not open text a future caller could typo.
- **Manual upload is server-side, single-shot - no client-side compression or resumable/chunked upload**, despite both being named in DOC-01 and master PRD §6.5. A plain file input covers correctness for typical photo sizes on a decent connection; the mobile-3G stress case that resumable upload exists for is a real gap, left for whoever revisits upload UX with field data in hand (recorded in D-14, not just here).
- **`completedByStaffId`-style dual-purpose columns were not reused here** - unlike R-011's task cancel path, Document's soft-delete has no "who restored it" column at all. Restoration is a full, ordinary state change with its own `document.restored` audit entry; who did it lives there, not on the row, since a restored document should look exactly like it was never deleted from every other query's perspective.

**What it left behind.**
- **Lease, Tenant, Vendor, Ticket and WorkOrder attachment is schema-ready but has no upload entry point** - each future item that builds that entity's CRUD adds its own.
- **No automated retention enforcement**, per the decision above - `documentsPastRetention()` exists and is tested; nothing calls it on a schedule yet.
- **No document detail/version-history page.** Versioning exists at the schema level (`Document.version`) but this item shipped only single-shot upload + soft-delete/restore; a real "replace this document" flow with a version chain is deferred until something actually needs to correct a previously-uploaded file rather than delete and re-add it.
- **No client-side compression or resumable upload**, per the decision above.

**Bugs found along the way.**
- **The dev server wedged mid-e2e-run again, the same failure mode as R-010's: this time from `exifr`'s isomorphic (browser + Node) bundle detection**, not a client-side Prisma import. Turbopack's build-time page-data-collection step logs `Couldn't load fs` / `Couldn't load zlib` for it - cosmetic (the build still succeeds, exit 0), but worth naming so a future session does not re-diagnose it as a real failure.
- **A double-submission bug in `restoreDocument`/`deleteDocument`: a plain `update()` throws P2025 ("no record found") if a second, near-simultaneous submission of the same action already won**, since a `<button>` has no built-in guard against a fast double click the way a disabled-while-pending state would add. Fixed by switching both to `updateMany()` + a `deletedAt` state check in the `where` clause, so the loser of a race no-ops instead of crashing the request - matches the idempotent-update pattern R-006's job runner already established for `JobRun`.
- **A genuine cross-connection read lag against Neon, the same class documented in R-008's duplicate-address flake**: the e2e test's own Prisma connection would read stale (pre-restore) `deletedAt` state immediately after a server action committed the opposite value on a different pooled connection. Fixed the same way R-008 did - `expect.poll()` on the read, not a single assertion.
- **A real, reproducible React hydration race, confirmed by inspecting the DOM mid-failure: a Server-Action `<form>` ships with a placeholder `action="javascript:throw ..."` until client-side hydration attaches the real handler.** The "Recently deleted" section is newly mounted (not merely revealed) after the delete action's `redirect()` swaps in a fresh server render, so its nested Restore button can be clicked before hydration catches up; a click that lands on the placeholder throws inside the page and leaves that form permanently broken for the rest of the test, so retrying the click afterward does not help - only waiting before the first click does. `networkidle` does not reliably capture this, since React's handler attachment is not itself network activity; fixed with a deliberate, evidence-based wait instead of a guess.
- **A test-writing lesson repeated from this session's own history: two separate `page.request` assertions checked the wrong thing.** `page.goto()`'s returned response reflects the page actually landed on after a redirect (`/no-access` itself renders 200), not the origin request's own status - so `expect(response.status()).not.toBe(200)` was backwards; the URL assertion already sitting next to it was the real check. And `getByText(..., {exact:false})` matches DOM presence regardless of visibility, so asserting a deleted document's filename had `toHaveCount(0)` failed correctly for the wrong reason - it had moved into the (closed, still-present) "Recently deleted" section, not out of the page; `not.toBeVisible()` was the check that meant what the test intended.
- **Found, not fixed - out of scope for this item: a pre-existing, deterministic mobile-chrome (Pixel 7 emulation) failure affecting 17 tests across `jurisdiction.spec.ts`, `properties.spec.ts`, `units.spec.ts` and `tasks.spec.ts`, none of which this item touched.** Every failure is the same shape - "`<label>` intercepts pointer events" blocking a submit-button click after scrolling a form into view on the narrow viewport. Confirmed unrelated to this item's diff: `git status` shows only two page files and new, isolated modules changed, none of them shared layout/shell/form components, and this item's own `documents.spec.ts` passes cleanly on mobile-chrome (7/7). `desktop-chrome` is fully clean (96/96). Whoever picks this up next should treat it as a standing gap in the mobile suite, not assume it will resolve itself.

## R-013 — Seed & demo data script
**Commit:** `b69f2a4`  ·  **Date:** 2026-08-04

**What it built.** `demo-seed.mts` (`npm run db:seed:demo`), separate from `seed.mts`'s reference data per the TODO that item's own docstring left behind. 2 legal entities, 6 properties across TX and FL, 8 units (including a duplex and an ADU), and 5 tenants, one in each of the lifecycle states the backlog names: current, late, in-notice, moving out, and inherited-at-acquisition. Idempotent by default (no-ops if the first demo entity already exists) with a `--reset` flag that deletes everything this script owns and reseeds from scratch. Verified by actually running it against the dev database (seed, re-run to confirm the no-op, `--reset` to confirm the rebuild, then a query script to inspect every seeded row's shape) rather than only reading the code back - the same standard `seed.mts`/`create-owner.mts` are held to, neither of which has a dedicated test file either.

**What it decided.**
- **All five "lifecycle state" tenants are represented through `Lease` and `Tenant` fields alone - `late` is the one exception, and even that stops at a single `Charge` row.** `current`/`in-notice`/`moving-out`/`inherited-at-acquisition` need nothing beyond `status`, `startsOn`, `endsOn`, `noticeGivenAt` and `moveOutAt`. `late` needs something that says "rent was due and nothing shows it was paid" - a `Charge` with a past `dueOn` and no linked `Payment` says exactly that, and `Charge` is fair game because it is core-computed and pushed TO Stripe (D-12), not sourced FROM it. What this script never creates is a `Payment` or `LedgerEntry` row: D-11 is explicit that `LedgerEntry` is an append-only projection built from Stripe webhooks, never written directly, and a row Stripe does not know about is a reconciliation bug by definition - fabricating one in a seed script would be exactly that bug, just deliberately.
- **"Inherited-at-acquisition" is modeled as a lease whose `startsOn` predates its property's `acquiredOn`** - Grant Okafor's tenancy started two years before the Sunset Boulevard property's (seeded) acquisition date, now continuing month-to-month. Both fields already existed on their respective models from R-002; nothing new was needed to represent the scenario, only choosing dates that put them in the right order.
- **Dates are computed relative to script-run time (`daysFrom(offset)`), not hardcoded.** The entire point of "late" and "moving out" is that they stay true whenever someone actually runs this - a fixed date would make the demo data quietly wrong the day after it no longer matched "today," the same class of staleness bug a hardcoded jurisdiction number would be.
- **No `AuditLog` entries for any seeded row**, matching `seed.mts`'s own reference data - this is bootstrap/fixture data, not a real user action, and the same convention keeps `--reset` a plain cascade of deletes with none of the "audited row is undeletable by the append-only trigger" complications R-008 through R-012 all hit in their own e2e cleanup.
- **Confirmed, not assumed, that leaving this data permanently in the shared dev database is safe**: no existing e2e assertion checks a raw total count of properties, entities or units for a portfolio-wide actor - every relevant assertion either scopes to a specific test-created name or (in `shell.spec.ts`'s property-switcher test) deliberately asserts an invariant ("zero, or more than one") rather than a count, for exactly this reason.

**What it left behind.**
- **No tenant portal credentials.** The backlog asks for tenants in each lifecycle state, not a way to sign in as one; `TenantCredential` rows were not created. A future item wanting a demo tenant login adds that, the same way `db:create-owner` is its own separate bootstrap rather than folded into this script.
- **Only Property, Unit, Tenant, Lease and one `Charge` per late tenant are seeded.** Guarantors, documents, tickets, work orders and everything else PRD §8's walking skeleton eventually wants are each the seeded-data responsibility of whichever item builds that entity's real workflow, not retrofitted here speculatively.
- **FL properties have no jurisdiction rule** - R-010 seeded Texas only (OQ-1's known gap). Nothing in this build reads a jurisdiction rule yet, so this is inert today, but it means the FL demo properties would hit `JurisdictionRuleNotFoundError` the moment something in a later item tries to compute a fee or notice for them.

**Bugs found along the way.** None - this item touches no application code, only a new standalone script, so there was nothing for the existing test suite to regress. The one real risk (permanent demo data colliding with an existing e2e assertion) was checked directly rather than assumed away, per the decision above, and came back clean.

## R-014 — Unit operational data
**Commit:** `da75126`  ·  **Date:** 2026-08-05

**What it built.** PROP-03's four kinds of per-unit operational data: access codes (lockbox/smart-lock/gate/mailbox, versioned like R-010's JurisdictionRule - never edited in place, a new code supersedes the old one, and the "history log" the PRD asks for is just every row that ever existed for that slot), appliances, utility accounts, and shutoff locations (with photos attached through R-012's existing Document upload, not a second photo mechanism). Codes are encrypted at rest with `sealSecret()`/`openSecret()` - R-003's AES-256-GCM primitive, extended with a `purpose` parameter so an access code and an MFA seed get cryptographically distinct derived keys from the same `AUTH_SECRET` rather than reusing one. Revealing a code is privileged and MFA-gated (`accesscode.reveal`, already in `PRIVILEGED_PERMISSIONS` since R-005) and every reveal is logged (`accesscode.revealed`), regardless of whether it is the first reveal or the fiftieth; adding a code is also logged (`accesscode.set`) but not MFA-gated, matching the distinction between "recording a fact" and "exposing a secret to a person." 14 core validation tests, 6 query integration tests, a domain-separation test for the encryption change, 9 e2e tests.

**What it decided.**
- **Access codes reuse R-010's JurisdictionRule versioning pattern exactly** - `AccessCode` is unique on `(unitId, type, version)`, adding a new one closes the prior version's `effectiveTo` inside the same transaction, and nothing is ever edited in place. The two entities have nothing to do with each other domain-wise; the shape (a value that changes over time and must never lose its history) is identical, so the schema is too.
- **`sealSecret`/`openSecret` gained a `purpose` parameter, defaulting to the exact string that made every existing MFA caller's derived key identical to before.** The alternative - a second encryption function copy-pasted for access codes - would have quietly diverged from the first the next time either one changed. The real reason this matters: a `purpose`-derived key means compromising the access-code key (say, a bug that logs decrypted codes somewhere it shouldn't) says nothing about the MFA key, and vice versa - cheap insurance for a two-line change.
- **A local ordinance's "full row, not a diff" precedent (R-010) extends to ShutoffLocation**: it is unique per `(unitId, type)`, so setting a shutoff location is an upsert - "the current word on where the water main is," never a growing, ambiguous list.
- **Setting a code is logged but not MFA-gated; revealing one is both.** PROP-03 asks for logged reveals specifically ("each reveal is logged"), and the two actions have different risk shapes - recording that a lock was re-keyed is an ordinary fact for the operational record, while decrypting a code and displaying it to a human is the moment the secret actually becomes exposed. Gating the write the same way as the read would not have made the data any safer and would have put an MFA wall in front of routine maintenance record-keeping.
- **Appliances and utility accounts get create/delete, not full edit-in-place** - a typo is corrected by removing the row and adding a fresh one, the same size/shape call R-012 made for its own document versioning. Access codes are the one type here that genuinely needs an edit-that-preserves-history; appliances and utilities do not carry that requirement in PROP-03.

**What it left behind.**
- **"Per-work-order" reveal is schema-ready (`workOrderId` is accepted and recorded on the audit entry) but nothing drives it yet** - there is no vendor-facing work-order UI to reveal a code FROM, since WorkOrder has no CRUD of its own until MAINT items land. Every reveal today is a staff member looking up a code to relay it themselves; a future item wires the real per-work-order flow through the same `revealAccessCode()` action.
- **One current code per `(unit, type)`** - a unit with two physical lockboxes needs a second `type` value or `OTHER` with a distinguishing label; this does not model multiple simultaneous codes of the same type.
- **No edit-in-place for appliances/utility accounts**, per the decision above.

**Bugs found along the way.**
- **A real, currently-shipped duplicate-`id` bug, the third instance of this exact class this session (R-010's payment-allocation checkboxes, R-012's per-row delete-reason select): `TextField`/`SelectField` derive their DOM `id` from `field-${name}` alone, with no way to disambiguate two different FORMS on the same page that happen to share a field name.** The unit detail page now hosts five such forms at once (document upload, access code, appliance, utility account, shutoff location), four of which have a field named `type` and two a field named `notes` - every one of those collided on one `id`, which is invalid HTML and meant `getByLabel()` (and a screen reader's own label association) resolved to the WRONG input for every colliding field but the first. Fixed by adding an `idPrefix` param to both components (mirroring the `value`-based fix `CheckboxField` already had for the identical shape), and by giving `DocumentsSection`'s per-row `DeleteForm` a `rowId` for the same reason - it collided with ITSELF the moment two documents existed on one page at once, which no test before this item ever happened to exercise.
- **A genuine React hydration race, the same class R-012 found and fixed, but this time surviving a plain wait: a `<details>`/form pair that is freshly re-rendered after a Server Action's `redirect()` needs a moment before a submit is safe, and 500ms was not always enough where 1000ms plus `expect.poll()` on the eventual database state reliably was** - the fix that actually held combined BOTH: a wait before the second interaction, and polling the read afterward for the same cross-connection Neon lag R-008 already documented, rather than trusting a single read immediately after the click.
- **A related but distinct bug in the SAME test: `<details>` is a native, uncontrolled element, and a Server Component re-render after `redirect()` never explicitly sets or clears its `open` attribute - so the browser's own toggle state can survive the transition.** A second unconditional click on the same "Add or replace a code" summary, assuming it always OPENS the section, could just as easily CLOSE an already-open one. Fixed by checking whether the form was already visible before deciding whether to click at all.
- **This item's own demo-data collision, found by running the full e2e suite rather than assumed clean: R-013's seeded legal entity "Bluebonnet Properties LLC" broke a `shell.spec.ts` assertion the instant a real multi-property list existed to trigger it** - an unscoped `getByRole('link', { name: 'Properties' })` substring-matched every property row whose OWNING ENTITY name happened to contain "Properties" too, and separately, R-013's "Magnolia Drive House + ADU" collided with `units.spec.ts`'s own test-created unit named "ADU" the same way. Both test locators had this latent fragility from the start - the sibling assertion two lines above the `shell.spec.ts` one was already correctly scoped to the nav - and both are fixed at the root (proper scoping), not papered over; the demo names were also changed to avoid inviting the next version of the same collision, with the stale old-named rows cleaned up by hand since a mid-session rename is outside what `demo-seed.mts --reset` itself can detect (now documented in that file directly).

## R-015 — Property filing cabinet
**Commit:** `9c2a609`  ·  **Date:** 2026-08-05

**What it built.** PROP-06's filing cabinet, four new property-scoped models: `Mortgage` (lender, balance, FIXED/ARM rate type, ARM adjustment date, maturity date, balloon flag), `InsurancePolicy` (carrier, limits, deductible, loss-of-rents flag, renewal date), `HoaInfo` (one per property, rental-cap policy as free text), and `Warranty` (roof/HVAC/water-heater/appliance/home-warranty category, provider, expiry). `Property.costBasisCents` is a single new field, not a fifth model - the deed/closing-disclosure figure PROP-06 asks for is one fact, not a repeating record. Every write is create/delete (HOA is upsert, since it's one-per-property); none are privileged, so none are MFA-gated or audited, matching R-014's identical call for appliance/utility-account CRUD. Three pure alert functions in `packages/core/filing-cabinet/alerts.ts` (`mortgageArmAdjustmentDue`, `mortgageBalloonMaturityDue`, `insuranceRenewalDue`) flag ARM adjustments 60 days out, balloon maturities 180 days out, and insurance renewals 60 days out, surfaced as inline badges on the property page - the same "report, not automated action" pattern R-012's `documentsPastRetention()` established, since real delivery belongs to the notification engine (R-016) and compliance calendar (R-077), neither of which exists yet. Documents attach through R-012's existing `Document` model with five new types (`DEED`, `MORTGAGE_DOC`, `INSURANCE_DECLARATION`, `HOA_DOC`, `WARRANTY_DOC`), not a dedicated upload per record, continuing the convention R-014 set for `ShutoffLocation`. 27 core validation/alert tests, 9 e2e tests covering CRUD, alert badges, scoping, and accessibility.

**What it decided.**
- **The three alert windows (60 days for an ARM adjustment, 180 days for a balloon maturity, 60 days for insurance renewal) are this build's own proposed defaults, not PRD-given numbers, except insurance's** - master PRD PROP-06 gives an explicit "45-60 days" range for insurance; this uses the wider, safer end as the single fixed trigger since a configurable lead-time UI is out of scope. Same "common practice, not a citation" posture R-010 used for its seeded Texas jurisdiction rule.
- **`INSURANCE_DECLARATION` is a new, deliberately distinct `Document` type from the pre-existing `INSURANCE_COI`** - a certificate of insurance is what a *vendor* provides to prove their own coverage; a declarations page is the property owner's own policy. Conflating the two would make R-012's per-type retention rule (and any future filter/search) wrong for one or the other.
- **Mortgage, InsurancePolicy and Warranty get create/delete, not edit-in-place; HOA gets upsert.** Same size/shape call R-014 made for appliances and utility accounts - a typo is corrected by removing the row and adding a fresh one. HOA is the one type here where "current state for this property" is the only thing that makes sense, the same shape as R-014's `ShutoffLocation`.
- **The interest-rate field is collected as a percent (e.g. "5.25") and converted to basis points at the write boundary**, and dollar amounts are collected as whole dollars and converted to cents - both follow `lib/units/actions.ts`'s existing `marketRentCents` convention of a friendlier unit in, the smallest unit stored, converted once at the boundary rather than trusted from the client.
- **Cost basis lives on `Property` directly and is edited through its own small form in the filing-cabinet section, not folded into the existing property edit page (R-008/PROP-01/04).** It's conceptually part of "the filing cabinet" (deed/closing disclosure), not the property's own identity fields (address, type, timezone) that edit page already owns.

**What it left behind.**
- **No warranty-coverage-before-dispatch flag.** PROP-06's other acceptance criterion ("given a work order created on a tracked asset, when the asset has an active warranty, then the system flags possible warranty coverage before dispatch") is explicitly R-024's job once work orders exist - this item only stores the data R-024 will read.
- **No CapEx/capital-improvement tracking.** That's PROP-07 (R-078), a separate backlog item; this item's warranties and mortgages are operational records, not the fixed-asset schedule.
- **Alert badges are computed at render time from the property's own records, not backed by the portfolio-wide `filingCabinetAlertsDue()` query also added in `lib/filing-cabinet/queries.ts`.** That query exists now as the hook point R-077's compliance calendar will read from - same shape as R-012's `documentsPastRetention()` sitting unused by any scheduler - but nothing calls it yet.
- **No edit-in-place for Mortgage/InsurancePolicy/Warranty**, per the decision above.

**Bugs found along the way.**
- **A real, now-fixed test collision in `e2e/documents.spec.ts`, the same class found three times earlier this session: `getByLabel('Type')` does a case-insensitive *substring* match by default, and this item's new "Rate type" field (Mortgage form) landed on the same property page as the pre-existing document-upload "Type" select.** Five call sites in that file went from unambiguous to strict-mode violations the moment both fields coexisted on one page. Fixed at the root - all five switched to the already-established `#field-doc-type` locator (the same fix R-014 applied to the unit page's own "Type" collision), rather than renaming the new field to dodge the substring match.
- **A genuine React hydration race on the cost-basis form, distinct in shape from every prior instance this session: the form is visible on first page load, not revealed by a `<details>` click.** Every other form in this build's admin UI is either behind a `<details>` (giving the user's own click-to-reveal a natural moment for hydration to catch up) or reached after a `redirect()` (already covered by the existing wait+poll pattern) - this is the first form that is neither, so filling and submitting immediately after `page.goto()` landed on the placeholder `action="javascript:throw..."` and silently no-opped. Fixed the same way as every prior instance: a deliberate wait before the first interaction, `expect.poll()` on the eventual database write instead of a single read afterward.
- **Found, not a defect in this item's diff: the long-lived dev server this session's `reuseExistingServer` Playwright config had been reusing since early in the session (2+ hours uptime) had drifted into a bad state** - `/login` intermittently rendered the tenant magic-link form instead of the staff password form, and Auth.js logged `Provider with id "password" not found`. Killing the stale process and letting Playwright start a fresh one resolved it immediately; likely accumulated drift from this session's several Prisma-client-regenerating migrations hitting one long-running Next dev process's hot-module state. Worth naming so a future session recognizes the symptom rather than re-diagnosing it as a real regression.
- **Found, not fixed - out of scope for this item: `apps/web/lib/jobs/jobs.test.ts`'s two event-outbox idempotency tests failed once under a full-suite run, then passed cleanly on an isolated rerun and again on a second full-suite run.** Confirmed pre-existing and unrelated to this item's diff - the same failure reproduces identically on `main` with none of this item's changes applied, and this item touches no job/outbox code. Consistent with a transient resource-contention flake, not a logic bug; left for whoever next touches that file to notice if it recurs.

## R-016 — Notification engine core
**Commit:** `a80f25e`  ·  **Date:** 2026-08-05

**What it built.** NOTIF-01's one engine, which every later module sends through: `notify()` resolves a recipient's channels against their per-category preferences, renders a template, and records the decision; `dispatchPendingNotifications()` hands it to a provider, outside any transaction. Deciding and sending are deliberately separate steps (see below). `Notification` is append-only at the database level, joining `LedgerEntry`, `AuditLog` and `Message` behind the same `reject_mutation()` trigger; `NotificationDelivery` is the mutable half a provider webhook may move, exactly the split R-002 already established for `Message`/`MessageDelivery`. NOTIF-02's per-category, per-channel preferences ship with a staff-facing screen on `/account`, and legally-critical categories are locked on with the explanation the story asks for. Quiet hours (21:00–08:00 property-local, D-3) **defer** rather than discard, with a drain pass on the hourly cron. A kill switch and a sandbox redirect guard the whole path. R-006's `CONSUMERS` array — shipped empty with this item named as one of its future fillers — gets its first real entry, wiring `unit.became_make_ready` to a staff notification. 20 core tests, 13 integration tests against a real database, 9 e2e tests.

**What it decided.**
- **Deciding and sending are separate steps, and that separation is the design.** `notify()` writes inside whatever transaction its caller already holds, so an outbox consumer's notification commits or rolls back with the consumer's own effects — which is what makes a retried consumer idempotent instead of a source of duplicate texts. `dispatchPendingNotifications()` sends outside any transaction, because a network call inside one holds a pooled Neon connection open for the length of a third party's outage, and a transaction that commits *after* the provider accepted the message is a message sent twice on retry. The gap between the two is bounded by the hourly cron and closed immediately by callers that want it closed.
- **A suppressed notification is still a row.** Preference off, no address on file, kill switch, unsupported channel — each gets a `Notification` with its rendered body and a `SUPPRESSED` delivery carrying the reason. "Why didn't the tenant get the late notice?" is the question this table exists to answer, and it is answerable at the moment somebody asks rather than by reconstructing what the preferences were three weeks ago. An absent row answers nothing.
- **Idempotency is a natural key supplied by the caller, suffixed with the channel.** `late-notice:<leaseId>:2026-08-03`, not a UUID: the key has to be derivable from the FACT rather than from the attempt, or a retry generates a fresh key and the guarantee is worth nothing. One logical notification fans out to one row per channel, so the channel is part of the stored key. A test drives five simultaneous calls and asserts exactly one row per channel survives.
- **Quiet hours defer, they do not discard** (NOTIF-05). Dropping a 21:30 rent reminder would silently lose a notification the product promised — a worse failure than a late one and much harder to notice. `DEFERRED` rows carry a `sendAfter` computed by stepping forward through the property's own timezone rather than by constructing a local timestamp and converting back, which is where DST bugs live; both 2026 transitions are tested.
- **Locked categories are policy, not a constraint.** NOTIF-02 names legal notices and emergency maintenance. A preference row saying otherwise is *ignored by the engine* rather than treated as an error, because policy changes with the law and a row written when the rules were different must not be able to silence a legal notice. The settings screen renders no control for them, the server action refuses to write one, and `resolveChannels` ignores one that exists anyway — three layers, and a test for each.
- **Emergency-bypass is deliberately narrower than locked.** A legal notice cannot be turned off but has no reason to arrive at 3am; there is no legal notice whose validity depends on it. Only `maintenance_emergency` bypasses quiet hours.
- **SMS defaults off for routine categories.** Texting somebody costs attention in a way email does not, and 10DLC carrier filtering punishes senders whose recipients report low-value messages — so the conservative default is off and opting in is a deliberate act. Locked categories, failed payments and work-order assignments are the exceptions.
- **The recipient is stored as `(recipientType, recipientId)` plus `toAddress` as used, not as four nullable foreign keys** the way `Thread` does it. `toAddress` is the actual evidence — "we emailed jane@example.com on the 3rd with this body" survives a tenant record being merged, renamed or deactivated, which is *stronger* proof than a foreign key to a row whose email has since changed. It also makes `NotificationPreference`'s unique constraint on (recipient, category, channel) expressible, which a compound unique across nullable columns is not in Prisma — the same wall R-010 hit on `JurisdictionRule.jurisdiction`. The cost is real and accepted: no referential integrity on `recipientId`. All four recipient kinds are deactivated rather than deleted in this product, so an orphan is theoretical, and an orphan is still readable evidence rather than a dangling pointer.
- **Notifications are NOT written into `Message`/`Thread`.** A `Message` requires a `threadId`, threading is R-017's item and does not exist yet, and a staff notification ("approval needed") has no conversation to belong to. R-017 can join the two when it lands; nothing here forecloses it.
- **Recipients are resolved at send time from live assignments, never from a stored subscriber list.** Who should hear about a property changes with assignments, and a list copied at registration time goes stale silently.
- **The provider drivers are a seam, not a stub (D-15).** See "left behind".

**What it left behind.**
- **No Resend or Twilio driver — this is D-15 and the item's single biggest deliberate gap.** Resend needs a verified sending domain with SPF/DKIM published; Twilio will not deliver to a US mobile number without an approved 10DLC brand and campaign, which takes days to weeks. Both are external workstreams the owner has to start, and **the 10DLC registration is the longest lead time in the project — it should be started now**, per the backlog's own note. Until they exist, a "real" driver could not be executed once, let alone tested; what it would be is an untested HTTP call that looks finished. Everything a real driver depends on is already exercised against the logging adapter, and swapping them in is a change to one assignment in `lib/notifications/provider.ts`.
- **`NOTIFICATIONS_SANDBOX_TO` is not set anywhere yet.** It must be set in every non-production environment before a real provider is wired — it is the control that stops a laptop pointed at a copy of production data from texting real tenants. Recorded in `.env.example` and D-15.
- **One template ships** (`unit.make_ready`), which is the mechanism proved end to end rather than asserted. Each later item writes its own — R-045 the payment ladder, R-020 emergency intake, R-027 entry notices, R-062 legal notices — the same way R-006 shipped `SCHEDULED_JOBS` and `CONSUMERS` empty.
- **Only staff can change preferences.** The table and the refusal are recipient-type-agnostic; tenants reach the same rows through the portal, which is R-018.
- **Quiet hours are not per-property configurable.** A product default (21:00–08:00) sits behind two functions every caller already goes through, so the first operator who asks adds a column and reads it there.
- **No retry ladder for a FAILED send.** Failures are recorded with the provider's code and `attempts` is counted, but nothing re-queues them yet — a retry policy wants real provider error codes to branch on, and there is no real provider.
- **No delivery webhooks.** `NotificationDelivery` is shaped for them (`externalId`, `DELIVERED`/`BOUNCED`, and it is deliberately not trigger-protected so a callback can move it) and a test proves the transition works, but no endpoint receives them.
- **NOTIF-04's daily digest and NOTIF-05's escalation chains are not built** — both are Should, and R-029 owns after-hours routing and on-call escalation for real.

**Bugs found along the way.**
- **A real design flaw in `notify()`, caught by its own test before it shipped: a channel with no address got no row at all, unless EVERY channel lacked one.** The first shape filtered the channel list down to addressable ones and iterated the filtered list, so a recipient with a phone but no email silently produced no EMAIL record — precisely the "notification the product promised and never recorded" failure the whole suppressed-row design exists to make impossible, reintroduced by an innocuous-looking filter. Fixed by resolving preferences over the addressable subset but iterating every channel the template declares, so an address-less channel records `SUPPRESSED`/`no_address` like any other refusal. The test that caught it was written before the fix and asserted the behaviour the design promised rather than the behaviour the code had.
- **The `page.goto()` status-versus-URL mistake, repeated from R-012 and corrected the same way.** A route-guard e2e assertion checked `response.status()` for 403; `requireScope` redirects to `/no-access`, which renders a perfectly ordinary 200, so `goto()` reports 200 for a request that was correctly refused. The URL assertion is the real check — and it is what `shell.spec.ts` was already doing two files over. Worth naming twice: this is now the second time this exact assertion has been written backwards in this project.
- **A stale item number in the nav, fixed in passing:** `/leases` was attributed to `ownedBy: 'R-016'` since R-007, but R-016 is this item — leases are R-033. Corrected, because a wrong item number in the placeholder is how a later session goes looking for lease work in the wrong place.
- **Two consequences of the append-only trigger, anticipated rather than discovered, and worth stating for whoever writes the next test file:** `Notification.propertyId` is `ON DELETE SET NULL`, `SET NULL` is an `UPDATE`, and the trigger rejects it — so a property with notifications cannot be hard-deleted and must be deactivated instead, exactly as `AuditLog` already forces in every existing spec. `NotificationDelivery` is deliberately left unprotected so cleanup and provider callbacks both work.

## R-017 — Comms threading core
**Commit:** `6a38a15`  ·  **Date:** 2026-08-05

**What it built.** COMM-01's one threaded history per tenancy, property and vendor, across portal, SMS and email, with logged phone calls sitting in the same transcript. `Thread` gained a deterministic `key` so get-or-create is safe under concurrency, and a denormalized `lastMessageAt` the inbox sorts on. The inbound path — `receiveInboundMessage()` — normalizes the sender to E.164, looks up every party it could belong to, and files it **only when exactly one party matches**; anything else lands in a new `UnroutedMessage` table for a human to place. Staff attribution is on every outbound row and rendered in the transcript. `/messages` is the inbox, `/messages/[id]` the transcript with a reply box and a call-log form, `/messages/unrouted` the triage queue. 26 core tests, 16 integration tests against a real database, 7 e2e tests.

**What it decided.**
- **The router refuses to guess, and that is the whole item.** Zero matches (wrong number, a tenant whose phone was never recorded) and several matches (a couple sharing a handset, a handyman who is also a tenant) both land in `UnroutedMessage` rather than being filed on a best guess. The asymmetry is the argument: a refusal costs somebody thirty seconds of triage, while a wrong match is a cross-tenant data leak carrying an audit trail that says it was legitimate. There is deliberately **no preference order** (tenants before vendors, newest lease first) — every such rule resolves an ambiguity the product cannot actually resolve, and turns a visible refusal into an invisible mistake.
- **Candidate lookup filters to LIVE leases and does not take the first.** Both halves matter and they pull opposite ways. Filtering to active tenancies is what lets a tenant who moved *within* the portfolio route normally — their old lease is ended, so only one property is in play. Not taking the most recent is what makes a tenant holding two *concurrent* leases refuse instead of silently filing "the tap is dripping" against whichever house they signed for last. The first draft had `take: 1`, which quietly picked; that was inconsistent with the stated principle and is now fixed and tested both ways.
- **Phone normalization is a security boundary, not formatting.** One canonical form (E.164) is stored and compared; anything that cannot be canonicalized confidently — short codes, extensions, letters, 7-digit numbers — is refused rather than coerced. Deliberately hand-rolled for NANP rather than pulling in libphonenumber: the footprint is Texas-first, and the swap is one function when a genuinely international number appears.
- **A thread's key includes the property, and that costs something worth naming.** A tenant who moves between two properties in the same portfolio gets two threads rather than one continuous history. The alternative leaves `Thread.propertyId` stale the moment they move, and `propertyId` is what every RBAC scope check filters on — a stale one means the manager responsible for the new property cannot read the conversation while the old one still can. Getting authorization wrong beats splitting a rare history.
- **Notifications and conversations are separate paths that share the delivery seam.** A staff reply is not routed through R-016's `notify()`: that path is templated, preference-gated and quiet-hours-deferred, none of which apply to a human answering a question a tenant just asked — and COMM-07 scopes quiet hours to "automated outbound" for exactly this reason. Both paths go through a new shared `deliverOverChannel()`, extracted from R-016's dispatcher, so the kill switch and the sandbox redirect cover conversation messages too. Nothing outside `lib/notifications` opens a provider client.
- **Evidence is written before transmission, always.** An outbound message is committed to the append-only log first, then sent; a provider that accepts a message we failed to record is a message the tenant has and we cannot prove we sent. The reverse — recorded, send failed, failure on the delivery row — is visible and recoverable.
- **A call note carries two timestamps.** `sentAt` is when the call happened (editable, may be well in the past); `createdAt` is when it was typed. The pair is what makes it contemporaneous rather than reconstructed, and writing up a call from last Tuesday deliberately does not jump the thread to the top of the inbox.
- **`MessageDelivery` gained `externalId`.** `Message.externalId` already covers inbound, where the provider hands the id over with the webhook. Outbound writes the immutable row before transmitting, so the id does not exist yet — it belongs on the mutable half, mirroring `NotificationDelivery.externalId`.

**What it left behind.**
- **No Twilio webhook route.** `receiveInboundMessage()` is provider-agnostic and fully tested without one; the transport that calls it needs D-15's 10DLC registration to clear first, and **R-021 owns turning an inbound text into a ticket**. Signature verification belongs with that route, not here.
- **Vendor threads are reachable but empty in practice** — a vendor's conversation hangs off the property of their last work order, and WorkOrder has no CRUD until R-024/R-025.
- **No thread export.** COMM-05's timestamped PDF transcript with delivery metadata is **R-052**, which this item deliberately leaves alone.
- **No templates** (COMM-03 is R-049), **no segment announcements** (COMM-04 is R-053), **no ticket/work-order threads** (COMM-06 is R-032), **no bounce/suppression handling** (R-054).
- **Unrouted messages can only be filed to a TENANT thread**, not a vendor or property one — tenants are the realistic case for an unplaceable text today, and the other two have no participants to choose from yet.
- **The triage list is deliberately unscoped.** An unrouted message has no property, so there is nothing to scope it against; the page guards on `message.send` rather than pretending a scope check happened.

**Bugs found along the way.**
- **A real timezone bug in logged call times, caught by two core tests that failed on the first run.** `<input type="datetime-local">` submits a wall clock with **no timezone**, and `Date.parse` on a zone-less string uses the *runtime's* zone — UTC on Vercel. A manager in Houston writing up a 14:30 call would have had it stored as 14:30 UTC, five hours off, which defeats the entire reason COMM-01 asks for a contemporaneous note. Fixed properly rather than papered over: new `wallClockToUtc`/`utcToWallClock` primitives in `packages/core/scheduling` resolve the wall clock in the **property's** zone (D-3), `validateCallLog` now takes a `Date | null` instead of a string so the mistake is unrepresentable in its signature, and transcripts render in property-local time. Both DST transitions are tested, including the hour that does not exist and the hour that happens twice.
- **A latent authorization bug I wrote and caught before shipping:** the thread page passed `legalEntityId: ''` into `propertyResource()`, which would have wrongly hidden the reply box from an entity-scoped manager — the exact bug R-008 already fixed once on its own Edit button. Fixed by selecting the real `legalEntityId` in the query.
- **The stale-dev-server drift from R-016 recurred and cost real time.** Seven e2e tests failed at sign-in with `getByLabel('Email')` matching four elements, because `/login` was serving the *portal* magic-link form. Same symptom as R-016's, same cause — a long-lived Next dev process that has outlived three migrations and several Prisma client regenerations — and the same fix: kill it and let Playwright start a fresh one. Six of the seven passed immediately after. **This is now the second item where this has bitten; treat a burst of implausible e2e failures as a stale server before debugging the diff.**
- **The integration tests leaked `UnroutedMessage` rows into the e2e suite.** Eleven pending rows had accumulated, and because the triage list is unscoped *by design*, they all rendered on `/messages/unrouted` and made "the File it button" ambiguous. Two genuine fixes rather than one workaround: the integration test now deletes the rows it creates (`UnroutedMessage` has a lifecycle and is not trigger-protected, unlike `Message`), and the e2e assertion scopes its click to its own row, since other rows on that page are legitimate and expected in production.
- **Two pre-existing `schema.test.ts` tests broke on the new required `Thread.key`** — the correct consequence of adding a NOT NULL column, fixed by giving those fixtures a key.

## R-018 — Tenant portal shell
**Commit:** `3472868`  ·  **Date:** 2026-08-05

**What it built.** The real tenant portal, replacing R-003's placeholder: a mobile-first shell at `/portal` with Home (their home, rent, and PORTAL-channel updates), Papers (their own documents), and Messages (their side of R-017's threads, with a reply box). Magic-link sign-in was already R-003's; this is where a signed-in tenant finally has somewhere to be. DOC-03's "only mine" is enforced as one pure predicate (`tenantCanSeeDocument`) mirrored by the query's own `where`, with a test that walks every document in the fixture and asserts the two agree. `/api/documents/[id]/file` became dual-principal: staff keep R-004's property-scoped RBAC, tenants get the scope check, and neither path falls through to the other. A PWA manifest (D-8) makes the portal installable, scoped to `/portal`. 8 core tests, 13 permission/integration tests, 11 e2e tests including axe on every screen.

**What it decided.**
- **Document visibility is an ALLOW-LIST on `tenantId` or `leaseId`, never `propertyId`.** A tenant sees a document because it names them or their tenancy, not because it lives at the address they rent. Written the other way round ("everything at the property except the sensitive ones"), every document type a later item adds defaults to visible and the first one somebody forgets to exclude is a leak. At a single property the landlord's file holds the deed, the mortgage note, insurance declarations, HOA papers, warranties (R-015), inspection reports, unit and shutoff photos — and **every other tenant's lease**. The default has to be invisible.
- **The rule exists twice on purpose, and a test holds the two together.** Once as a pure predicate (readable, argued about, unit-tested) and once as a Prisma `where` (so the database does the filtering, because a row that reached the browser is disclosed whatever the markup did). Two expressions of one rule is exactly the shape that drifts, so `portal.test.ts` walks the whole fixture and asserts they agree row by row, including the landlord's own documents.
- **"Not yours" and "does not exist" are indistinguishable.** Every tenant-scoped lookup returns null / 404 rather than 403. A 403 on a guessed document id confirms that the id belongs to somebody at the address the guesser rents, which is a real disclosure even without the bytes.
- **The portal has its own guard, not a branch inside the staff one.** Staff authorization is RBAC over property scope; a tenant's is "these are my own records" and has no roles, permissions or property scope at all. Folding them together would put a conditional about principal kind at every call site, and the day one is written backwards is the day a tenant is authorized by a staff code path. `requireTenant()` refuses a STAFF session outright rather than upgrading it — a staff member who needs to see what a tenant sees gets a deliberate impersonation feature with an audit entry, not an accident of this check.
- **A tenant's scope is every lease they were EVER on, not their live ones.** A former tenant chasing a deposit needs their lease and its disposition paperwork, and that is exactly when they are no longer current. The session is the thing that expires: auth.ts already refuses to issue or keep one for an inactive Tenant.
- **This is where the accessibility standard is set, per the backlog's own words.** 16px base minimum (the staff shell's default is 14px, so this is a real difference), 44px touch targets, landmarks and a skip link, pinch-zoom never disabled, and no status encoded by colour or position alone — who sent a message is said in words, because a bubble on the right is not information to a screen reader. An e2e test asserts the viewport meta never acquires `user-scalable=no` and that `main` computes to ≥16px, so the next item cannot quietly regress either.
- **Plain language is a product decision, not copywriting.** No status enum reaches a tenant screen — `MONTH_TO_MONTH` becomes "You are renting month to month". Money is said out loud ("Your rent is $1,850.00 a month"). Dates are "5 August 2026", never ISO and never a numeric format that means two different days either side of the Atlantic, rendered in the property's timezone. D-10's lexicon throughout: "Papers", not "Documents"; "home", never "unit" or "door".
- **§6.4's staff-mediated fallback is stated on the page.** "You can also call or text the number on your lease — you do not have to use this site." Gene (P4, paper-preferring) is the acid test, and the point of writing it on the front page is that nobody is funnelled through the portal to reach a person.
- **A manifest, deliberately not a service worker.** An installable, correctly-scoped manifest is the whole of D-8's claim today (no app-store wall, home-screen install, magic-link deep linking). Offline caching with a sync queue is different work with its own failure modes and is **R-028's**; shipping an empty service worker now would claim offline support this build does not have.

**What it left behind.**
- **No balance, payments or maintenance requests.** The portal shows what exists: money is R-035+/R-039, and the maintenance request flow is **R-019**, the next item. The front page says so in tenant words rather than showing empty sections.
- **No move-in condition report.** It is the one document a tenant arguably should see that the current rule excludes — it hangs off an Inspection, which is R-070's. Whichever item builds it adds a third clause to `tenantCanSeeDocument`, in one place, with a test.
- **No staff impersonation.** Named above as the correct answer to "what does the tenant see", deliberately not built here — it needs an audit entry and a visible banner, which is its own small item.
- **No tenant notification preferences.** R-016 built the table and the refusal recipient-type-agnostic; the tenant-facing screen for it belongs with the portal's account section, which does not exist yet.
- **No push notifications.** The manifest is installable but nothing subscribes; SMS remains the backstop per §6.5.

**Bugs found along the way.**
- **A real robustness bug in the document download route, found by a fixture that recorded a size it had not written:** `Content-Length` was taken from `Document.sizeBytes` rather than from the bytes actually being sent. The two agree for every file this product wrote, but the header is a promise about THAT response — if the stored object and the recorded size ever disagree (a half-written upload, a storage backend swapped under D-14), the response is malformed and the client aborts mid-download showing nothing. Now taken from the buffer, where it cannot disagree.
- **`requireTenantWithScope(` does not substring-match `requireTenant(`,** so R-004's route-guard test flagged four new portal pages as unguarded. The test was right and the fix is a new entry rather than shortening the existing one to a bare prefix — a prefix would also match a comment that merely mentions the guard, which is precisely how R-009 caught this test passing pages for the wrong reason.
- **The e2e test's `process.cwd()` and the dev server's are different directories.** Next runs with `apps/web` as its working directory, so a test writing storage bytes to `<repo>/.data/documents` produced a file the server looked for in `apps/web/.data/documents` and could not find — a 500 that read as an authorization failure until both `.data` directories turned up on disk. Worth knowing for any later test that touches the local storage adapter.
- **`getByText('From you')` matches "From your landlord".** The same substring-collision class as R-015's "Rate type" and R-014's "ADU", caught here by a test that would otherwise have passed while asserting nothing. Scoped to the message's own row.
- **The stale-dev-server failure from R-016 and R-017 recurred, and the trigger is running `next build` while the e2e dev server is up.** A full-suite run failed 36 tests, every one of them `/login` serving the tenant magic-link form alongside the staff password form so `getByLabel('Email')` matched four elements. The dev server and `next build` share `apps/web/.next`; building while Playwright's `reuseExistingServer` process is live corrupts that process's route manifest, and this item's route-group move (`/portal/page.tsx` into `/portal/(signed-in)/`) made the corruption visible as pages served under the wrong layout. Both earlier occurrences followed a mid-item build too. **Rule for the gate: build LAST, or restart the dev server afterwards — never build while the e2e server is running.** Killing the process and deleting `.next/dev` recovered it.
- **Then I made it considerably worse, which is worth recording as its own lesson.** Chasing the above, I edited `e2e/portal.spec.ts` and launched a second Playwright process *while the full suite was still running against the same server and database*. That run reported 117 failures — none of them real, all of them self-inflicted by two concurrent runs sharing one dev server and one database, plus a spec file changing underneath the runner. The first pass had also been read wrong: `tail`-ing the output hid the `N failed` count that sits above the failure list, so a run with 36 failures looked like "76 passed". **Run the suite alone, let it finish, and read the summary line rather than the tail.**
- **One pre-existing assertion in `auth.spec.ts` broke by design** — it looked for the placeholder's "Welcome, Dana Reyes" heading, which is now "Hello, Dana" in the plainer register §6.4 asks for. Updated, with the reason recorded next to it.

## R-019 — Tenant maintenance request flow
**Commit:** `bb16eda`  ·  **Date:** 2026-08-05

**What it built.** MAINT-01's tenant-facing intake: category (seven of them - plumbing, electrical, HVAC, appliance, pests, exterior, locks) → 2-3 structured clarifying prompts → a category-specific troubleshooting script with pictures, only when one applies, gated so dispatch cannot proceed without a tried/declined answer for every step shown → photos, upload never blocking the flow → entry permission → pet warning → review → submit, one linear phone-first wizard with no dead ends. The seven named troubleshooting steps (breaker, GFCI, disposal reset, thermostat battery, furnace switch, pilot light, toilet flapper) all exist, each attached to the category - and in three cases the specific clarifying answer - it actually helps for. A submission becomes a real `Ticket` row (`source: PORTAL`), with `Ticket.habitabilityFlag` set by a keyword scan of the tenant's own words (mold, leak, no heat, sewage, infestation) for R-023's later triage to read. 22 core tests, 7 integration tests, 7 e2e tests including the troubleshooting gate, habitability detection, photo attachment, cross-tenant scoping, and axe on every screen.

**What it decided.**
- **Emergency categories are deliberately NOT in this item.** MAINT-01's own acceptance criteria split cleanly along the backlog's own item boundary: R-019's line asks for the seven ordinary categories and their troubleshooting scripts; R-020 (**Emergency intake path**, depends on R-019 AND R-016) owns the emergency subset - safety-first instructions, the shutoff photo, skipping troubleshooting entirely, and paging on-call regardless of hour. Half-building the emergency branch here (without R-016's notification engine to page anyone) would have meant either a fake "we've paged someone" or a silent no-op standing in for a safety-critical claim - worse than not building it yet.
- **The tenant never free-types a paragraph.** `formatMaintenanceDescription` turns the structured answers into the one readable transcript that becomes `Ticket.description`, in the order they were asked - a tech opening the ticket sees what the tenant actually saw and answered, not a bag of field:value pairs, and the tenant spends their two minutes tapping, not composing.
- **A troubleshooting step's applicability is one function, used by both the wizard and the validator.** `applicableTroubleshootingSteps(category, answers)` decides what to SHOW and what validation REQUIRES an answer for from the same logic - the alternative (the UI deciding independently from the validator) is exactly the shape that drifts: a hidden step the validator still silently demands, or a shown step nothing requires an answer for. Concretely: the furnace-switch and pilot-light scripts only appear for "Heating", not "Cooling" - showing them regardless would be actively bad advice, not merely extra.
- **Entry permission and the pet warning are each a real yes/no answer, never a checkbox default.** `undefined` (never answered) is refused exactly like a missing category; `false` is a real, valid, deliberate answer. A checkbox's implicit `false` default is indistinguishable from a tenant who never saw the question, and both fields matter downstream - entry permission drives R-027's scheduling compliance check, and the pet warning is safety information a vendor relies on before opening a door.
- **Photo upload starts the instant a photo is picked; Submit gives it a short, bounded grace period (3s) rather than either an infinite wait or none at all.** "Never blocks submission on a slow link" governs the FIRST several seconds-to-never of a bad connection, not a photo that is realistically almost done - so Submit waits briefly for whatever is already in flight, then proceeds with whatever is ready regardless. See "bugs found" below for the design this replaced and why it did not actually work.
- **`Ticket.description` is generated server-side from structured input the client cannot forge into free text**, and `MaintenanceFormState`/`SubmitMaintenanceRequestArgs` are passed as typed objects to Server Actions called directly from client code, not through `<form action>` - the wizard's shape (a dynamic set of prompts and troubleshooting steps per category) does not map cleanly onto one FormData submission the way every other action in this build has.
- **The submission itself is audited (`ticket.submitted`), verbatim, separately from the Ticket row.** `Ticket` is not append-only - status, priority and category all get edited during triage (R-023) - so the audit entry is the one place the tenant's ORIGINAL words survive intact, the same "audit the write too, not only what happens to it later" call R-012 made for `document.uploaded`.
- **`MAINTENANCE_PHOTO` joins `DOCUMENT_TYPES` as its own type**, distinct from staff's `UNIT_PHOTO` library (R-012/PROP-08's versioned condition-over-time record) - a tenant's photo of today's problem is evidence for one ticket, not a turn-over history.

**What it left behind.**
- **No emergency path** - R-020, discussed above.
- **No staff-side triage view beyond the existing `/maintenance` placeholder.** R-022 (staff-logged requests) and R-023 (the triage queue) are what a staff member actually works from; this item only guarantees the `Ticket` rows they will read are correct and complete.
- **Video was in MAINT-01's prose but not in R-019's own backlog line ("photos ... upload never blocks"), and this item follows the line: photos only.** Video upload is real additional complexity (bigger files, transcoding/preview concerns) with no acceptance criterion naming it as R-019's own scope.
- **No background-sync queue for a dropped upload.** If a tab closes or a hard reload happens before an upload (or its 3-second grace period) finishes, that one photo is not attached automatically - the ticket detail page's "Add a photo" affordance, reusing the same upload/attach mechanism, is the honest recovery path. A real offline queue is R-028's job, built for the tech's job list, not this one.
- **Troubleshooting illustrations are inline schematic SVGs, not real photography** - this build has no photo library for a tenant's actual breaker panel. The mechanism (an image next to plain-language instructions) does not change when real photos become available; only the source does.

**Bugs found along the way.**
- **A real architectural bug in the first "never blocks" design, caught by an e2e test with a file that should have uploaded near-instantly and still failed reliably.** The original design had a photo's own upload promise attach itself to the ticket from a `.then()` continuation AFTER Submit had already navigated to the new ticket's page - "the ticket exists by the time this upload finishes, so attach it then." It read cleanly and was wrong: a client component's promise continuation is not guaranteed to complete its own follow-up Server Action call once the page that created it has navigated away, and in practice the attach call never fired at all - confirmed by checking the database directly (the `Document` row existed; `ticketId` stayed `null`) and by instrumenting the server action, which never logged a single invocation. Rebuilt on a different, more boring foundation: `submitMaintenanceRequest` no longer redirects itself - it returns `{ ticketId }`, so the wizard can wait a short bounded period (`waitForPendingUploads`, 3s) for in-flight uploads BEFORE navigating, reading each upload's own resolved result from a plain ref map (written synchronously the instant it settles) rather than through React state, which is only ever a rendering snapshot and can lag behind what has actually resolved. This is the second time this session a design built around "attach it later, after this component might already be gone" has turned out to be the wrong shape for the App Router's navigation model - worth remembering the next time a flow wants to do something asynchronous around a redirect.
- **The Next.js dev toolbar's own button matches `getByRole('button', { name: 'Next' })` by substring** ("Open Next.js Dev Tools" contains "Next"), which is invisible in a spec with only one "Next" button on the page but broke every single click once the wizard had its own "Next" button on it. Fixed with `{ exact: true }` throughout - the same substring-collision class found repeatedly this session, this time from framework chrome rather than another feature's UI.
- **Two assertions hit the same cross-connection Neon read lag documented since R-008**, reading the newly-created ticket immediately after the page's redirect rather than polling for it. Fixed with `expect.poll()`, matching the established pattern.

## R-020 — Emergency intake path
**Commit:** `4c58f44`  ·  **Date:** 2026-08-05

**What it built.** MAINT-01's emergency criterion, the branch R-019 deliberately left out. All nine emergencies the PRD names (gas smell, CO alarm, electrical burning/sparking, active flooding, sewage backup, no heat in freezing temps, no AC in dangerous heat, break-in, only toilet inoperable) as their own vocabulary, each with written safety-first instructions shown BEFORE anything is submitted, the relevant shutoff surfaced from R-014's unit record, no troubleshooting script at all, `priority: EMERGENCY`, and an on-call page sent immediately in the same request rather than waiting for the hourly cron. Reached from the top of the maintenance screen and from an escape hatch on the ordinary wizard. 17 core tests, 12 integration tests, 10 e2e tests including axe on the red safety screen.

**What it decided.**
- **Emergencies are a separate vocabulary, not a flag on R-019's seven categories.** Everything about them differs - no clarifying prompts, no troubleshooting, a safety screen first, EMERGENCY priority, a page that ignores quiet hours. A single list with `isEmergency: true` would put "is this the kind that can kill somebody" behind an `if` at every call site instead of in the type.
- **The gas and CO paths deliberately show NO shutoff, even when one is on file.** This is the sharpest decision in the item and it is a safety decision, not a data one: the right action for somebody who can smell gas is to leave, and the gas shutoff is at the meter - sending them hunting for a valve, possibly with a phone torch, possibly in a basement, is worse advice than "get out". `EmergencyDefinition.shutoffType` is null for both, and an integration test asserts `shutoffForEmergency` returns nothing for a gas smell *at a unit that has a gas shutoff recorded*, so the null cannot be mistaken for missing data later.
- **Instructions are ordered, and the ordering is load-bearing.** `selfProtection` is an array read top to bottom: "Leave the home now" is the first line for a gas smell, and "call 911" comes after it, because a phone call from inside is the thing to avoid. The no-heat instructions pre-empt the classic secondary killer (heating a home with an oven or a generator) rather than only addressing the cold. Tests assert on this content, not merely on its presence.
- **"Paged immediately regardless of hour" is two separate mechanisms, and both were already built.** Quiet hours are bypassed because `maintenance_emergency` is in R-016's `EMERGENCY_CATEGORIES`, so `notify()` never defers it - nothing here re-implements a quiet-hours check. The *immediacy* comes from calling `dispatchPendingNotifications()` in the same request instead of leaving the page to the hourly cron. R-006's own dispatcher comment already anticipated this: "a latency floor of one hour ... fine for nightly work and NOT fine for an emergency maintenance page". The event bus still gets `ticket.created` for non-time-critical consumers (R-023's triage queue); the page does not depend on it.
- **Priority is set here, breaking R-019's own rule, and the exception is principled.** Everywhere else this build refuses to guess at priority because a category is weak evidence for one, leaving it to R-023's triage. Here it is not a guess: the tenant read "I smell gas" and chose it. `habitabilityFlag` is set outright for the same reason rather than run through R-019's keyword scan, which reads free text an emergency submission is not required to contain.
- **The submission is never gated on typing.** No clarifying prompts, no required description - only the category, plus entry permission and a pet warning, both one tap and both genuinely needed by somebody opening a door at 2am. A required text field between a tenant and "somebody now knows" is a field that costs minutes.
- **On-call is everyone holding `ticket.write` on the property, and it over-pages on purpose.** R-029 owns the real on-call toggle and the escalation chain (page → SMS → call → backup). Until it exists, waking three people for a gas leak is the correct failure direction and waking none is not. Named explicitly in the code so R-029 replaces one function rather than hunting for the assumption.
- **The page cannot fail the submission.** `pageOnCall` is wrapped so a provider outage cannot turn "we recorded your emergency" into an error screen that makes a tenant think nothing was reported. The ticket is already committed by then; a failed page is recorded on its own delivery row (R-016), which is where support looks.
- **The SMS template leads with the word EMERGENCY, then the thing, then the address, then the tenant's phone** - in that order, because somebody half-awake reads the first line to decide whether to get out of bed, and the very next thing they do is call the tenant. Deliberately not link-first: a link is useless to somebody who has to drive.

**What it left behind.**
- **No escalation chain and no on-call roster** - R-029, as above. Today every eligible staff member is paged simultaneously with no "if nobody acknowledges in 15 minutes" step (NOTIF-05).
- **SMS still does not physically send.** R-016's logging adapter is what a page goes through, so "paged" today means "recorded and dispatched to the adapter". D-15's 10DLC registration is the gate, and **it remains the longest external lead time in the project** - this item makes it materially more urgent, since an emergency page is the one message that genuinely cannot wait for email.
- **No auto-response to the tenant.** COMM-07's after-hours auto-response is R-029's; today the confirmation screen carries the reassurance instead.
- **`NO_AC_DANGEROUS_HEAT` has no thermometer behind it.** MAINT-01 says "no heat in freezing temps / no AC in dangerous heat", and nothing here checks the actual temperature - the tenant's own judgment is the trigger. Wiring a weather source to gate a safety path on an API call would be worse, not better.
- **The `pagesOnCall` flag is true for all nine.** It exists because `ONLY_TOILET_INOPERABLE` is the one a reasonable operator might later make a next-morning job, and that is a config decision (R-029's on-call rules), not a property of what the tenant reported.

**Bugs found along the way.**
- **A real access-control gap this item had to open, narrowly and deliberately.** R-018's `tenantCanSeeDocument` is an allow-list on `tenantId` or `leaseId`, and a shutoff photo (R-014) carries neither - it is attached to the *unit*. So MAINT-01's "the relevant shutoff photo displays" was, before this item, impossible: the download route would have refused the tenant their own home's safety photo. Widened by exactly one clause, keyed on the document *class* (`SHUTOFF_PHOTO`) AND unit membership - not "unit documents are visible", because the same unit record holds PROP-08's versioned condition photo library including **photos from previous tenancies of the same home**. `TenantScope.unitIds` is optional so every pre-existing caller keeps compiling, and an absent list matches nothing, which is the safe direction for a field whose only job is to widen access. Six new pure tests cover what it now allows and what it still refuses; two integration tests prove the SQL agrees.
- **The two expressions of the document rule had drifted into three copies.** Extending it meant editing the `where` clause in `listTenantDocuments` and again in `getTenantDocument` - exactly the duplication R-018's own drift test exists to catch. Extracted to one `visibleDocumentWhere(scope)` builder both now share, so the next extension is one edit rather than two-and-hope.
- **`jobs.test.ts`'s event-outbox test failed once during the full run and passed on re-run** - the pre-existing flake documented in R-015. Confirmed unrelated (it passes in isolation and on a full re-run of all 668). But this item IS the first to leave `ticket.created` events pending in the shared outbox, and `dispatchOutbox()` is global and batched, so the e2e spec now cleans up the events it emits - the same shared-state hygiene lesson R-019 learned with `UnroutedMessage`.

## R-021 — SMS-to-ticket
**Commit:** `4455b1b`  ·  **Date:** 2026-08-05

**What it built.** Twilio's inbound-SMS webhook at `POST /api/sms/inbound`, authenticated by request signature, on top of R-017's routing: a text from a known tenant threads into their conversation and opens a maintenance ticket (`source: SMS`), while a further text during an open ticket threads into it instead of opening another. Habitability language in a text starts the same response clock the portal path does. An unroutable text opens no ticket at all and lands in R-017's unrouted queue. 18 core tests (11 of them signature verification), 9 integration tests, 9 e2e tests hitting the real endpoint with genuine, forged, and tampered signatures.

**What it decided.**
- **The webhook was built now rather than deferred to 10DLC, and D-15 supports that rather than contradicting it.** D-15 refuses to ship an untested outbound HTTP CLIENT to a provider we cannot call. A RECEIVER is the opposite case: it is our own endpoint, and Twilio's signature algorithm is documented and fully exercisable offline against a known key. Inbound also does not depend on 10DLC at all - a Twilio number can *receive* before the campaign clears - so the practical effect is that the number can be pointed at this today. `TWILIO_AUTH_TOKEN` is now the one Twilio value worth setting as soon as a number exists, and `.env.example` says so.
- **The signature is implemented here rather than pulled from the `twilio` SDK.** Fifteen lines, and it is the entire authentication of a public endpoint that writes to somebody's permanent conversation and opens tickets in their name - worth having in a file with its own tests rather than behind a dependency's version bump. Constant-time comparison, length-checked first because `timingSafeEqual` throws on a mismatch and an exception from an auth check is a 500 where a clean `false` belongs.
- **The signed URL comes from `AUTH_URL`, not from the request.** Behind a proxy `request.url` is the internal address while Twilio signed the public one, so verifying against `request.url` would fail every real request in production and pass every one in development - the worst possible split. Taking the host from `X-Forwarded-Host` instead would hand an attacker control of a value inside the signature payload.
- **NOT every text is a ticket, and this is the decision that makes the feature usable.** A tenant mid-conversation types "thanks", "ok see you then", "any idea when someone can come?" - three messages, one problem. Opening a ticket per text would bury the real queue in conversational noise within a week. So the first text with nothing open becomes a ticket and everything after threads into it until that ticket closes; a text after the last thing was resolved genuinely is new and opens another. R-023 has a merge-duplicates tool because duplicates happen - that is not a licence to manufacture them.
- **An SMS ticket carries no category.** R-019's structured intake earns one by ASKING; a text has answered nothing, and a keyword guess would put a wrong label on the one intake path with no clarifying prompts to correct it. `UNCATEGORIZED` is honest, and R-023's triage assigns the real one from a human reading the words. The tenant-facing screens render it as "What you texted us" rather than leaking the placeholder (D-10).
- **Habitability detection runs on a text exactly as on a portal submission.** MAINT-02/RISK-05's response clock cannot depend on which channel the words arrived through - "there's mold in the bathroom" is the same fact either way. Reuses R-019's scan verbatim.
- **Status codes are control signals, not just reports, because Twilio retries on any non-2xx.** 403 for a bad signature (deliberately not retryable - it will still be bad, and a forged request should not earn repeat attempts). 400 for a signed request missing `From` (just as absent next time). **503** when `TWILIO_AUTH_TOKEN` is unset, specifically so messages sent during a misconfiguration window are redelivered once it is fixed rather than silently lost. 500 on an unexpected failure, because a transient database error is exactly where redelivery recovers a message - and `receiveInboundMessage` is idempotent on `MessageSid`, so the retry cannot duplicate what did commit. 204 on every success **including unrouted**, since an unrouted message was recorded for a human and asking for a retry would only duplicate it.
- **No auto-reply TwiML.** COMM-07's after-hours auto-response is R-029's, and inventing one here would be a message the operator never configured going out under their number.
- **A vendor's text threads but opens no ticket.** "Running late" from a plumber is not a tenant reporting a problem.

**What it left behind.**
- **The number is not pointed at this yet** - that is a Twilio console setting (`{AUTH_URL}/api/sms/inbound`), documented in `.env.example`. Nothing in code can do it.
- **No `Thread.ticketId` linkage.** The column exists and R-032 (work-order comms threading, COMM-06) owns ticket-scoped threads properly. Setting it here would point one long-lived tenant thread at whichever ticket happened to be open when a text arrived, and go stale at the next one - a wrong pointer is worse than none. Staff reach both from the tenant today.
- **No MMS.** Twilio sends `NumMedia`/`MediaUrl0` for picture messages and this ignores them; a photo texted in is described in the body but not attached. Fetching media needs an authenticated call back to Twilio's API, which is the outbound-client case D-15 defers.
- **No STOP/HELP handling.** COMM-02 requires honouring STOP automatically; that belongs with the outbound path and the suppression list (R-054), since it governs what we may SEND.
- **The 503-when-unconfigured path cannot be exercised in the same run as the signature tests** - the test server has a token set precisely so the security-critical tests do not silently skip. The test for it is present and skips with its reason stated.

**Bugs found along the way.**
- **`auditAsSystem` could not be imported without dragging Auth.js in, which broke the integration test at module load.** `lib/audit/index.ts` imports `auth()` to resolve the current principal, so importing it *at all* - even purely for the request-less `auditAsSystem` - pulls in a module that cannot load outside a request context. Its own header already claimed the split ("splitting them is what lets a background job record audit entries with a SYSTEM actor and no request at all"); R-021 is where the file layout finally matches the claim. `auditAsSystem` moved to `lib/audit/system.ts` with no auth import, re-exported from index for existing callers. R-008 hit this same wall with `guard.ts` and solved it the same way.
- **Four integration tests failed on first run because the feature works.** Each reused the same tenant, so every test after the first correctly threaded into the still-open ticket instead of opening a new one. The fix was a `closeOpenTickets()` helper, not a change to the rule - worth recording because the failure output ("expected 'threaded' to be 'ticket_opened'") reads like a bug and is the opposite.
- **A full-suite run failed 68 tests and then a re-run was SIGKILLed outright - and the cause was outside this project entirely.** A concurrent session working on the *storage business* repo runs `lsof -ti :3000 | xargs -r kill -9` before its own e2e, and both projects default to port 3000. That killed this project's dev server mid-run (producing the `/login` serving-two-forms symptom recorded under R-016/R-017/R-018) and then killed the retry's Playwright process. **Re-running with `PORT=3100` sidesteps it completely.** Worth stating plainly because the earlier occurrences of this symptom were diagnosed as `next build` corrupting a running dev server, which is a real and separate hazard - but at least some of those failures were almost certainly this instead, and no amount of care inside this repo would have prevented them. If a burst of implausible e2e failures appears again, check for another session on port 3000 before suspecting the diff.
- **The e2e signing helper read `AUTH_URL` from the wrong process, and only ever worked by coincidence.** The route verifies against the URL it reconstructs from the SERVER's `AUTH_URL` (which playwright.config sets to `baseURL`), while the test built its signature from the TEST process's `AUTH_URL`, which comes from `.env.local`. Both were `:3000`, so it passed - until the port clash above forced a run on `:3100` and every signed request came back 403, correctly. Fixed to sign against Playwright's own `baseURL`, which agrees with the server by construction and makes the spec port-independent. A test that passes only when two unrelated values happen to match is a test that will fail on somebody else's machine.
- **The e2e signature tests would have passed for the wrong reason without a token on the test server** - the route correctly refuses everything with 503 when `TWILIO_AUTH_TOKEN` is unset, so all five forgery tests would have skipped and the suite would have looked green having proved nothing about the security boundary. `playwright.config.ts` now sets a fixed fake token for the dev server and the test process, and the skip conditions state explicitly why they exist.

## R-022 — Staff-logged (phone-reported) requests
**Commit:** `f0983d6`  ·  **Date:** 2026-08-05

**What it built.** A staff form at `/maintenance/new` ("Log a phone-reported request") that turns a call into the same kind of `Ticket` a tenant's own portal submission or a text produces - `source: PHONE_LOGGED` instead of `PORTAL`/`SMS`, same category taxonomy, same entry-permission/pet-warning fields, same habitability keyword scan. A bare `/maintenance` list and `/maintenance/[id]` detail view came with it, replacing the placeholder that already named this item as its owner - not R-023's triage queue, just enough for a logged ticket to be visible and reachable by id regardless of which door it came through. 12 new core tests (validation, description formatting), an e2e spec covering the happy path, habitability flagging, server-side trim validation, and ROLE-01 scoping.

**What it decided.**
- **The submission is a plain `<form action>`, not the tenant wizard's imperative pattern.** R-019's wizard calls its server actions directly from client code because the step sequence is dynamic per category (troubleshooting scripts, conditional prompts). A phone log has none of that - staff is writing up a call, not walking themselves through one - so the ordinary Server Actions form binding already used by `units/actions.ts` and `tasks/actions.ts` is the simpler, correct fit.
- **No clarifying prompts, no troubleshooting gate.** `validatePhoneLoggedRequest` is deliberately lighter than the tenant path's `validateMaintenanceRequest`: a category, free-text notes, and the same real yes/no entry-permission and pet-warning answers (never defaulted - "not asked" stays distinct from "no", same reasoning as R-019). Forcing staff through the tenant's own structured prompts on a live call would slow down the one channel where the human already knows more context than any form could ask for.
- **The picker is one option per `LeaseTenant`, not per `Lease`.** A lease with two tenants on it offers each by name rather than making staff guess which one is on the phone. `OPEN_TICKET_STATUSES` moved from a private `Set` to an exported array in `packages/core/comms/sms-intake.ts` so the new staff queue's `status: { in: [...] }` filter and R-021's `isOpenTicketStatus` read the same list - a second copy is exactly how "what counts as open" would eventually drift.
- **No outbox event.** Mirrors `submitMaintenanceRequest`'s own choice, not R-020's or R-021's: an ordinary (non-emergency) ticket is already visible the instant its creator is looking at it, staff or tenant, so nothing downstream needs an async signal for it yet.
- **Permission is re-checked against the property the submitted `leaseTenantId` actually resolves to, not just "did the page that rendered the picker filter to this actor's scope."** Same defense-in-depth every other `lib/*/actions.ts` write in this repo already applies (`createUnit`, `addTask`) - the page's filtering is a courtesy, not the boundary.

**What it left behind.**
- **`/maintenance` is a bare list - status only, sorted by recency, no priority, no merge, no SLA timer, no habitability auto-elevation.** R-023 owns turning it into the real triage queue; this exists only so a phone-logged ticket (and every other source) is provably visible somewhere before that item builds the workflow on top.
- **No call is logged as a conversation note.** COMM-01's "staff phone calls are logged as timestamped call notes in the same thread" is R-017's `logCall`, already shipped, and reachable from a tenant's own thread page. This item deliberately did not fold the two together - a Ticket and a thread note are different records serving different readers, and merging them here would have meant re-deciding R-017's own design mid-item.

**Bugs found along the way.**
- **`dispatchOutbox()` crashed the whole batch when a row it had just read got deleted before its own `update()` ran.** Not something this item's code touches - `logPhoneMaintenanceRequest` never calls `emitEvent` - but the full gate wouldn't stay green: `jobs.test.ts`'s outbox test and R-021's `sms-intake.test.ts` (which does `emitEvent` and deletes its own rows in `afterAll`) run in parallel Vitest workers against the same dev database, and `dispatchOutbox()` is deliberately unscoped (a real cron sweeping the real outbox, correctly system-wide in production). When the timing lined up, `outboxEvent.update({ where: { id } })` threw P2025 for a row another file's cleanup had just removed. Fixed by switching both branches to `updateMany` - it reports zero rows touched instead of throwing, which is the correct outcome either way: nothing left to mark. R-020's PROGRESS entry had already logged this same test as "flaked once, confirmed unrelated"; this time it reproduced on every run, so the fix belongs here even though the feature doesn't.
- **A regex reused from the SMS webhook spec, `/\/maintenance\/.+/`, also matches the page it starts on.** `page.waitForURL(/\/maintenance\/.+/)` called from `/maintenance/new` can resolve immediately - "new" satisfies `.+` - without ever waiting for the click's actual redirect, so the ticket-lookup assertion right after it ran before the write had committed. Looked exactly like a missing ticket. Fixed with a pattern that excludes `new` and requires a real id.
- **Two seeded-fixture-selection bugs in the e2e spec itself, not the product**: `selectOption({ label: RegExp(...) })` isn't valid Playwright API (label match wants an exact string), and `selectOption({ index: 1 })` picked whatever the portfolio-wide "owner" scope happened to list first - which, once other tests' fixtures were in the same database, was not reliably this test's own caller. Both fixed by selecting on the option's `value` (the `leaseTenant.id`), which is unambiguous regardless of how many other properties are in scope.

## R-023 — Triage queue as a Task view
**Commit:** `1270f06`  ·  **Date:** 2026-08-05

**What it built.** Every new Ticket now becomes a Task in the one staff queue (D-9) - "Triage queue as a `Task` view" is the backlog's own phrase for this, and it is meant literally: triage is not a second list, it happens on the same `/tasks/[id]` page every other work item already uses, with a ticket-specific panel bolted on when `task.subjectType === 'Ticket'`. That panel carries: a priority override (`URGENT`/`ROUTINE`, never `EMERGENCY` - see below), merge-duplicate into another open ticket at the same property, and the three terminal resolutions MAINT-02 names outright - waiting on tenant, converted, closed - each of which completes the Task the same way finishing any other task does. A first-response SLA badge (on track / approaching / breached) sits alongside the ticket's own fields. Priority is now computed at intake too, not left at the schema's `ROUTINE` default: `suggestTicketPriority()` reads category (a weak signal, per R-019's own already-stated reasoning) and habitability (RISK-05's auto-elevation, which is a hard override, not a suggestion). 18 new core tests, 5 narrowly-scoped integration tests for the outbox consumer, 6 e2e tests covering the full triage flow plus scoping and accessibility.

**What it decided.**
- **A `ticket.created` outbox consumer creates the Task, reacting to an event every intake path already had reason to emit - not a fifth call site hand-rolling the same `createTask()` invocation.** Mirrors R-016's own `unit.became_make_ready` consumer exactly. Two intake paths (`submitMaintenanceRequest`, `logPhoneMaintenanceRequest`) had never emitted `ticket.created` at all - both R-019 and R-022 explicitly chose not to at the time, reasonably, since nothing consumed it yet. This item is what changes that calculus, so both now emit it.
- **Delivery is the hourly outbox's, so a triage Task can lag its Ticket by up to an hour - the same "fine for nightly work, not fine for an emergency" tradeoff R-006 already made, applied here rather than re-litigated.** The Ticket itself is never hidden in the meantime: it has been live on `/maintenance` since R-022, the instant it's created. A genuine emergency never goes through this path at all - R-020's own intake pages on-call synchronously, bypassing the bus entirely, which is exactly the boundary this lag is safe to accept for.
- **Priority override stops at `URGENT`/`ROUTINE` - a PM cannot set `EMERGENCY` from the triage panel.** `EMERGENCY` pages on-call the moment R-020's own intake sets it; this action has no paging behind it, so allowing it here would look like escalating while nothing downstream reacts. A ticket that turns out to be a real emergency after the fact needs a phone call, not a status field pretending to be one.
- **"Converted" sets `Ticket.status = CONVERTED` and stops there - it does not create a `WorkOrder`.** That row, and everything around dispatching it (scope, access details, cost estimate, vendor assignment), is R-024's own build, which depends on this one existing first. The ticket detail page names R-024 directly where the work order will eventually render - the same honest-placeholder pattern `SectionPlaceholder` already established for this whole section before R-022 built the list under it.
- **`isTicketTriageResolved()` is one function, used by both the page (whether to show the resolved summary or the action forms) and the actions (whether to refuse a stale or replayed request) - not two independently-drawn lines that could disagree.** Caught during its own build: the first draft only treated `MERGED`/`CLOSED` as resolved, so revisiting an already-converted or already-waiting-on-tenant ticket's task re-showed the action forms as if nothing had happened, and the action-level guard would have let a replayed "convert" request silently re-run against an already-completed task.
- **`task.read` does not imply `ticket.read` on the shared task-detail page, even though every role in this build happens to grant both together today.** The page checks `ticket.read` explicitly before fetching or rendering anything ticket-shaped; a future task-only role that never anticipated this page would otherwise leak a tenant's maintenance description through it. `maintenance_tech` (which holds `ticket.read` but not `ticket.write`) is the real, present-day role this distinction is for - it sees the ticket's content but none of the triage controls.

**What it left behind.**
- **No proactive notification when the SLA "nears breach."** MAINT-02 names both a visual escalation and an owner notification; R-023 declares only R-019 and R-011 as dependencies, deliberately not R-016, and there is no periodic sweep anywhere in this product yet that could decide "this crossed the line since I last checked" and call `notify()`. The visual badge is real and lives on the panel; the push is future work for whichever item adds a periodic SLA sweep - a natural fit for R-029's after-hours routing, which already owns escalation chains.
- **The SLA clock is wall-clock hours, not business hours.** A real "4 business hours" measure (skip nights and weekends, per property timezone) needs calendar machinery `packages/core/scheduling` does not provide yet. Wall-clock always warns at least as early as business-hours would, never later - the correct direction to be wrong in for a habitability-adjacent clock, but a real gap for a ticket filed Friday evening.
- **No reopening.** Once a ticket is `WAITING_ON_TENANT` or `CONVERTED`, its triage Task is done and the panel goes read-only; there is no "the tenant replied, put this back in front of someone" path. Today that conversation happens through R-017's own thread reply, already reachable from the ticket - a human has to remember to look. A real fix threads tenant replies back into an open triage state and is its own item, not a corner to cut inside this one.
- **The merge picker is portfolio/property-wide by ticket list, not narrowed to the same unit or tenant.** Deliberately: a PM reading two descriptions side by side is a better duplicate detector than any heuristic this item could add, and R-023 explicitly leaves duplicate detection to a human (MAINT-02's own framing).

**Bugs found along the way.**
- **`createTask()`'s idempotent create-then-catch fallback broke the moment a real caller used it from inside an active transaction.** `dispatchOutbox()` wraps every consumer in its own `prisma.$transaction`, and R-023's consumer is the first caller of `createTask()` to run that way. A P2002 collision inside that transaction leaves it aborted at the Postgres level; the fallback's own `db.task.findUniqueOrThrow()` - reusing the same, now-poisoned transaction client - failed with 25P02 instead of returning the row that already existed, the opposite of what the function promises. Fixed by reading the fallback through the plain top-level `prisma` client, never the possibly-aborted `db` the caller passed in; a fresh connection sees the winner's already-committed row cleanly. Covered by a new regression test that reproduces the exact shape (`create.test.ts`, "survives a collision hit from INSIDE a transaction").
- **A Vitest test file that imports `jobs/registrations.ts` for its side effect registers every real consumer for the rest of that worker process's run, not just its own file.** `CONSUMERS` is a plain module-level array; Vitest does not give each test file an isolated copy of it the way `units/auto-make-ready.test.ts`'s own header comment assumed. The first version of this item's own consumer test imported the whole registration chain and, once it ran, R-016's real `notify-unit-make-ready` consumer started actually processing `auto-make-ready.test.ts`'s fixtures for the first time ever in Vitest - breaking that file's cleanup, which (correctly, until this point) had never needed to delete `EventConsumption` rows before `OutboxEvent`. Fixed two ways: `auto-make-ready.test.ts`'s cleanup now deletes in the FK-safe order (matching e2e's own established pattern), and this item's own consumer test imports only `triage-consumer.ts` directly rather than the whole registration chain, so it registers exactly one consumer instead of every real one.
- **The same broadened-consumer-reach idea, tried a second way, exposed a second, unrelated latent bug and was reverted rather than chased further.** Wiring a fixed `CRON_SECRET` into `playwright.config.ts` (the same fix R-021 applied to `TWILIO_AUTH_TOKEN`, so `e2e/cron.spec.ts`'s own "runs when the bearer token is right" test would stop silently skipping) let this item's e2e spec dispatch the real outbox over HTTP - but `/api/cron` also runs R-009's `runDueJobs()` for every property in the database, and batch-deleting two or more e2e-created properties that each pick up a same-day `JobRun` row collides on `JobRun`'s own `(jobType, COALESCE(propertyId,''), businessDate)` unique index, because the FK is `ON DELETE SET NULL` and multiple simultaneously-nulled rows land on the same collapsed value. That is a real, schema-level landmine, but fixing it properly is R-006/R-009's own scope, not a side effect of this item's e2e coverage - so the `CRON_SECRET` wiring was reverted, `e2e/cron.spec.ts` is back to its original (unchanged, still-honest) skip, and `e2e/triage.spec.ts` seeds the Task row directly instead of dispatching cron - the consumer's own wiring is what the narrowly-scoped Vitest test above proves instead.

## R-024 — Work order creation & assignment
**Commit:** `8c17678`  ·  **Date:** 2026-08-05

**What it built.** Work orders, from a ticket or standalone (a make-ready turn has no ticket behind it - MAINT-03's own example): scope, priority, an optional cost estimate, and assignment to exactly one of an in-house tech or an external vendor. R-023's own "Convert to work order" triage resolution finally leads somewhere real - a "Create work order" link now sits where placeholder text used to. The in-house "mobile job list with full context" MAINT-03 asks for IS the Task queue (D-9): an assigned tech's work order becomes a Task the same way R-023 already made a new ticket become one, with a read-only panel carrying photos, appliance make/model/serial/filter size, a link to reveal access codes, and the tenant's phone. Warranty status (PROP-06) surfaces on both the create form and the work order's own detail page, with a same-category match flagged as the likely one; `ON_HOLD_WARRANTY` is a real, reversible state a PM can put a claim into and take it back out of. 14 core tests, 9 narrowly-scoped integration tests for the assignment consumer, 9 e2e tests across creation, assignment, warranty hold, scoping and accessibility.

**What it decided.**
- **The in-house job list is the Task queue, not a second list.** `assignWorkOrder()` emits `workorder.assigned` only for a staff assignment; a consumer (mirroring R-023's own ticket-triage consumer exactly) turns that into a Task pre-assigned to that tech - not left for anyone to claim, since a PM chose them specifically. A vendor assignment never reaches this at all: a vendor has no login (D-6) and nothing to claim from a queue built for staff. Completing a job Task does not itself change the work order's own status - real verification and closeout (labor, materials, invoice, tenant sign-off) is R-030's build, and folding a typed completion into this item would have been reaching into scope that names its own dependency chain.
- **Warranty surfacing shows every active warranty on the property, with a same-category match flagged, rather than trying to guess which single warranty applies.** A PM reading provider and coverage is a better judge of what's actually covered than a fuzzy match would be; a wrong guess (PLUMBING ticket, WATER_HEATER warranty - the same asset to a human, two different strings to a matcher) would bury a real match under a false one, worse than showing every row plainly.
- **Creating a work order from a ticket is what actually sets the ticket to CONVERTED and closes its triage task, not the triage resolution button.** R-023's "Convert to work order" button still exists and still means "a PM decided this needs one" - but it now leads to this form rather than silently flipping a status with nothing behind it. Reaching the form directly (skipping the triage click) is handled too: creation closes any still-open triage task itself, so a shortcut never leaves an orphaned task sitting in the queue for a ticket that no longer needs triaging.
- **The approval-threshold gate (MAINT-04's ceilings, "over $X enters Pending Approval") is deliberately NOT built here**, even though `checkMonetaryAuthority()` already exists from R-004 and `WorkOrderStatus.PENDING_APPROVAL` already exists in the schema. MAINT-04 is R-026's own PRD section, not MAINT-03's, and the backlog's own dependency direction (R-026 depends on R-024) confirms it: this item creates and assigns; R-026 owns deciding whether an estimate needs a second signature before either happens.
- **`task.read` does not imply `workorder.read` on the shared task-detail page**, the same line already drawn for `ticket.read` in R-023 - a future task-only role must not leak a work order's scope and assignment through the one page every task shares, even though every role today happens to grant both together.

**What it left behind.**
- **Vendor dispatch is recording only - nothing is sent.** Assigning to a vendor sets `vendorId` and moves the work order to `ASSIGNED`; no magic link, no SMS, no email goes out. That mechanism, and the difference it makes ("the difference between a maintenance module vendors use and one they ignore," per the backlog's own line for R-025), is R-025's entire build, which depends on this one existing first.
- **No bid-collection workflow, no re-approval on cost overrun, no owner two-tap approve/deny/ask.** All MAINT-04, all R-026.
- **No scheduling.** `scheduledStart`/`scheduledEnd` sit unused on the schema; entry-notice compliance and tenant/vendor coordination are R-027's build.
- **The `workorder_job` Task type is not registered in `AUDITED_TASK_TYPES`.** Nothing about completing it is a typed, audited event yet, because nothing about completing it means anything specific yet - that lands with R-030's real verification and closeout, the same "R-011 ships before its first consumer" honesty this build's own registry file already documents for every task type that doesn't need it yet.
- **Reassignment same-day is handled, but only by updating the existing open Task's assignee - a Task already marked DONE by the first tech is left alone rather than reopened.** A PM reassigning a job that already has a completion note attached needs to look at what happened, not have it silently vanish and reappear for someone else.

**Bugs found along the way.**
- **The same aborted-transaction footgun `createTask()`'s own fallback was fixed for in R-023 bit a second, independent caller.** `job-consumer.ts`'s reassignment fix-up ran `tx.task.update()` immediately after a `!created` result - which means `tx` had just absorbed the P2002 that made `created` false, leaving it aborted at the Postgres level for the rest of its lifetime. Two callers independently hitting the identical class of bug within two items of each other is a strong signal it belongs at the source: `createTask()`'s own doc comment now states the contract explicitly ("`!created` means `tx` is unusable for anything further - use the plain client instead"), so a third caller does not have to rediscover it by crashing first.
- **A stale e2e assertion in R-023's own spec, exposed by this item's UI change.** R-024 replaced the "Work order creation ships in R-024" placeholder text (which R-023's own e2e test asserted verbatim) with a real "Create work order" link. Fixed the test to assert the link and its `href` instead of frozen placeholder copy - the kind of coupling worth naming so a future item that finishes a NEXT placeholder knows to expect the same.

## R-025 — Vendor magic-link work orders
**Commit:** `811e3e1`  ·  **Date:** 2026-08-06

**What it built.** The zero-login vendor surface D-6 has been pointing at since project setup: a PM clicks "send the vendor their link", the vendor gets a text or email, and everything they need to do the job lives behind one URL with no account anywhere. Scope, address with a maps link, the tenant's name and tappable phone number, the photos of the problem, the equipment on site (make/model/serial/filter size from R-014). Accept, decline with a reason, or propose a window. Reveal an access code — logged individually, every time. Upload completion photos and an invoice, where a photo of a handwritten total is a first-class invoice (MAINT-03's own "even a napkin photo"). Mark the work finished. Plus the no-response timer: an hourly sweep that raises a re-dispatch Task when a vendor goes quiet past their priority's threshold, and `fallbackVendorsForTrade()` to rank who to try next. 24 core tests, 10 integration tests on the link itself, 8 e2e tests weighted toward what the link refuses.

**What it decided.**
- **D-16, the central decision: a vendor link is multi-use until it expires, not single-use — amending the PRD in four places rather than quietly diverging from it.** "Single-use" is right for a token whose job is to *establish* a credential (a tenant magic link becomes a session; burning it costs nothing). A vendor link **is** the credential — there is no account and no session behind it — so burning it on first click means the plumber who opened the text at 7am to accept cannot reopen it at 4pm to send the invoice. That is not an edge case; accept-now / photograph-later / invoice-later is the *only* real vendor workflow, and it spans hours or days by nature. Single-use would fail on the second step of every job, and "the vendor phones the invoice in instead" is exactly the outcome D-6 exists to prevent. **Rejected alternative**: single-use redemption into a work-order-scoped session cookie — preserves the letter of "single-use" but dies on a cleared cookie, a second device, or simply re-clicking the original SMS, which is the most likely way a vendor returns. **The control set that replaces single-use**, all of it built and tested: scoped to exactly one work order; expires (3 days); reissuing revokes every prior link, so resending is how a leaked link is killed; dies when the job closes or is reassigned; every action audited with the vendor named. `07-decisions.md` records this, and `link.ts`'s header states that if any of those five stops being true, the multi-use argument has to be re-argued.
- **`redeemToken()` is deliberately not used, and the schema comment that said "single-use" was corrected rather than left to mislead.** `AuthTokenPurpose.VENDOR_WORK_ORDER` is now the one purpose in the product that is multi-use, and it says so at the enum. Every other purpose stays single-use and must.
- **A reassigned vendor's link dies immediately, enforced twice.** `vendorLinkAccess()` compares the token's own vendor against whoever the work order currently names, and `assignWorkOrder()` separately revokes the old links. Belt and braces on purpose: the office cannot recall a text message, so this comparison is the only thing between a replaced vendor and a live gate code. It has its own integration test and its own e2e test, both named for what they are.
- **Access codes are revealed by a deliberate action, never rendered on load, and logged on every reveal — not just the first.** The audit entry is the answer to "who could have opened this door on the day of the break-in", and a vendor opening the code to write it down and again three days later are two separate facts. Only an *accepted* vendor sees the reveal button at all: somebody who has not answered, or who declined, has no business holding a code, and "the link is still technically live" is not a good enough reason.
- **`auditAsVendor()`, not `auditAsSystem()` with a vendor id in `ref`.** A vendor is a real, identified external party who accepted a job and opened a gate code; the trail has to say so in the column a query filters on. Folding them into SYSTEM would make "show me everything this vendor touched" unanswerable without string-matching free text — and that is precisely the question asked after an incident.
- **A vendor answers once.** Changing their mind is a phone call, because staff may already have told the tenant somebody is coming, and a vendor silently flipping accept to decline is how a tenant waits in all afternoon for nobody. Uploading stays open much longer than answering, since the invoice normally lands after the work is done.
- **The no-response sweep runs hourly from the cron tick, NOT as a `SCHEDULED_JOBS` entry — D-3 read carefully rather than by reflex.** Every scheduled job runs once per property per *local day* because those answer calendar-day questions, and a calendar day is property-local. This measures *elapsed hours* since a dispatch, which is the same duration in every timezone; and a daily job would be useless for the case it exists to catch, since an emergency's threshold is two hours. It raises a **Task**, not a notification: the answer to a silent vendor is a PM deciding to re-dispatch and picking who — that is work, and D-9 says work goes in the one queue.
- **Missing W-9 / expired COI are surfaced on the fallback list, not filtered out of it.** MAINT-11 blocks *payment* without a W-9; it does not forbid dispatching the only plumber who answers at 2am. Hiding them would leave a PM wondering why the list is short.

**What it left behind.**
- **Nothing actually reaches a vendor's phone yet — D-15, unchanged.** The dispatch goes through the notification engine to the logging adapter; Resend and Twilio remain a one-assignment swap blocked on a verified domain and an approved 10DLC campaign. The e2e spec reads the link back out of the notification body, which is both how it gets the token and a real assertion that the message carried it.
- **"Propose a time" is recorded, not scheduled.** `proposedStart/End` are the vendor's suggestion; `scheduledStart/End` stay untouched, because confirming a window has to pass an entry-notice check first and that is R-027's build.
- **Marking work complete does not close anything.** It sets `WORK_COMPLETE` and stops. The tenant's one-tap "was this resolved?", reopening on a no, vendor reopen-rate, and the invoice→property-books chain are all R-030.
- **Re-dispatch is a prompt, not an action.** The sweep raises the Task and `fallbackVendorsForTrade()` ranks the candidates, but a PM still assigns and sends manually — there is no one-click "try the next vendor" yet, and no automatic escalation.
- **`NO_RESPONSE_HOURS` is a constant, not configuration.** MAINT-03 says "config"; this is 2/8/24 by priority in code, with a `ponytail:` note. Deliberate: D-4's never-hardcode rule is about numbers a *statute* can change, and no statute says how long a landlord waits on a plumber. Promote it when an operator actually wants a different number.

**Bugs found along the way.**
- **A `'use server'` module may export only async functions, and TypeScript cannot see it.** `vendorRejectionMessage()` is a pure lookup that turns a rejection reason into words a vendor can act on; putting it in `actions.ts` typechecked and linted clean, then failed the production build. Moved to its own `messages.ts` rather than wrapped in a pointless `async`. Worth recording because the gate order matters: typecheck and lint both pass on this, and only `npm run build` catches it.
- **The e2e helper polled `dispatchedAt`, which is set before the message exists.** `dispatchToVendor()` writes `dispatchedAt` inside its transaction and calls `notify()` afterwards, so a poll on that column returns while the notification the test needs to read the token from has not been created. Fixed to poll for the notification itself — the thing actually being waited on.
- **Two test-isolation bugs in the same helper**, both real rather than cosmetic: it looked up "the newest `/vendor/` link anywhere", which under parallel workers hands one test another test's token (fixed by scoping to the property), and its cleanup tried to `DELETE` from `Notification`, which is append-only by trigger exactly like `AuditLog` (fixed to delete only the deliveries and leave the notifications, as the trigger intends).

## R-026 — Approval thresholds
**Commit:** `5991ae1`  ·  **Date:** 2026-08-06

**What it built.** The financial control this product has been carrying the parts for since R-004: an entity-level cost threshold above which a work order needs an explicit approval, staff ceilings that route over-ceiling requests up automatically, an owner's two-tap approve / deny-with-reason / ask-a-question decision, re-approval when actuals run past what was agreed, and MAINT-04's fourth criterion — bid collection above a bid threshold, with each vendor pricing through their own zero-login link and the answers compared in one table. `checkMonetaryAuthority()` and `requireMonetaryAuthority()` were built in R-004 and left deliberately callerless with a comment saying the caller's job would be to "create that approval" rather than treat over-ceiling as a failure; this is that caller. 38 core tests, 12 e2e.

**What it decided.**
- **Two different numbers govern one decision, and conflating them is the bug the core module exists to prevent.** The ENTITY'S THRESHOLD is about the money — the owner saying which spends are worth their attention, regardless of who asks. A STAFF CEILING is about the person — may *this* actor be the one who says yes. `approvalRoute()` asks them in that order, always: ask about the person first and a $10 filter change goes up for signature; ask about the money only and a $300-ceiling manager approves $5,000. Both directions have their own named test.
- **Thresholds live on `LegalEntity`, not on Property and not in a global singleton.** The LLC is this product's ownership boundary (Entity → Property → Unit), and an owner with a partner in one LLC and none in another genuinely wants different numbers. Falls back **per field**, not per object, and with `??` rather than `||` — a configured zero threshold means "approve everything", which is a real policy a cautious owner might set, and `||` would silently replace it with the $500 default. That has its own test.
- **A work order with no estimate needs no approval, and the actuals check is what catches it.** R-024 made the estimate optional precisely because a PM creating a work order with a tech already in the unit often has no number, and blocking dispatch on one would stop exactly the emergency work this product exists to move quickly. The money is still seen — just at the actuals stage rather than up front.
- **Re-approval is measured against `approvedAmountCents`, a new column, not against the current estimate.** An estimate can be revised after approval; measuring against it would make the tolerance check defeatable by editing a number. Tested directly ("approve $500, edit the estimate to $5,000, spend $900" must still go back).
- **A denial CANCELS the work order rather than leaving it pending.** A denied job is not going to happen, and leaving it in the queue as "pending" would have the PM waiting for an answer already given. Re-scoping is a new work order — which is also the honest record, since the thing the owner said no to is not the thing that gets done. An "ask", by contrast, leaves it pending: a question is not an answer, and the approval is still owed.
- **Denying and asking need no ceiling; only approving does.** Requiring authority to *refuse* a spend would be backwards.
- **Bids get their own token purpose (`VENDOR_BID`), not R-025's.** A dispatch link is one-per-work-order and reissuing revokes the previous one — that is D-16's control set. Bids need N vendors holding live links to the same work order simultaneously, the exact opposite. Sharing the purpose would have meant weakening the dispatch invariant for every work order in the product to serve a workflow only some of them use. A bid link also dies the moment the job is assigned to somebody, so a slow bidder cannot answer a job already awarded.
- **A `WorkOrderBid` row is created when a vendor is ASKED, not when they reply**, so "who was asked and never answered" is answerable — half of what a comparison is for. The compare view keeps silent vendors on the table for the same reason: a comparison that quietly drops the two who ignored you tells the wrong story about how much shopping around happened.
- **`actorDecision()` was added beside `actorCan()`** for the handful of screens where *why* changes what to say — see the bug below.

**What it left behind.**
- **Thresholds have no settings UI.** They are columns on `LegalEntity` with sensible fallbacks, set today by seed or by hand. The entity edit form is R-008's surface and adding three money fields to it is a small, separate change; nothing here is blocked on it.
- **`APPROVAL_DEFAULTS` are constants.** MAINT-04 says "config", and the per-entity columns are that config; the *fallbacks* are code. Deliberate, and consistent with R-025's own `NO_RESPONSE_HOURS` reasoning: D-4's never-hardcode rule governs numbers a statute can change, and no statute sets an owner's comfort with a repair bill.
- **Awarding a bid is manual.** The comparison shows who quoted what, cheapest flagged; the PM then assigns and dispatches through R-024/R-025's existing controls. There is no "accept this bid" button that assigns the vendor and copies the price into the estimate in one step — worth adding, but it is convenience on top of a complete workflow rather than part of it.
- **No notification when an approval is waiting.** It lands in the one queue (D-9) as a Task, which is where MAINT-04's "≤2 taps from a phone" actually happens; a push on top is R-016 wiring that nothing here blocks.

**Bugs found along the way.**
- **The approval panel told the one person who could act that somebody else had to.** `workorder.approve` is in `PRIVILEGED_PERMISSIONS`, so ROLE-05 gates it behind MFA — correct. But `actorCan()` collapses every denial into `false`, so an owner with unlimited authority who simply had not verified MFA got "Waiting on somebody with approval authority": a dead end, shown to the exact person holding the power. Found by an e2e test that signed in with a password only. Fixed two ways: a new `actorDecision()` that keeps the reason, and a panel that now offers a link to set up the second factor and says why it is needed. The e2e now enrols and verifies MFA on every approver, because a password-only session genuinely cannot approve a spend and testing that state was testing a state no approver is ever in.
- **A pre-existing R-020 failure that was NOT mine, proven by stashing.** `e2e/emergency.spec.ts`'s paging test timed out, reproducibly. Stashing every R-026 change and rebuilding reproduced it exactly, which is the only way to tell a regression from an inheritance. Root cause: `pageOnCall()` notifies **everyone** holding `ticket.write` on the property and dispatches inline in the same request (both deliberate, both documented in R-020) — and the shared dev database had accumulated **2,390 staff rows, 15 of them still holding portfolio-wide grants**, so one emergency submit was creating and sending 45 notifications synchronously. The debris was mostly from `e2e/vendor-link.spec.ts`'s own `afterAll` throwing partway through on the append-only `Notification` table (fixed during R-025, but the rows it had already stranded remained). Cleared the stale test staff; the spec went from failing at 42s to passing in 18s. **The underlying design characteristic is real and unchanged** — paging everyone, inline, does not scale — but replacing it is R-029's named job, and doing it as a drive-by inside an approvals item would be exactly the unscoped change to a safety-critical path that should not happen quietly.
- **The bid e2e polled the wrong thing, the same way R-025's dispatch helper did.** `requestBids()` writes the bid row *before* calling `notify()`, so polling the row count was satisfied while the message the token is read from did not exist yet. Second time this exact race has appeared in two items; the fix is the same both times — poll for the artifact you are about to read, not for a proxy that lands earlier.

## Follow-up to R-026 — the emergency page no longer flushes the global queue
**Commit:** `1167f54`  ·  **Date:** 2026-08-06

**What it fixed.** R-026's write-up recorded that R-020's `pageOnCall()` "pages everyone, inline, and does not scale" and left it as R-029's to solve. That deferral was half right. Paging *everyone* is genuinely a design question R-029 owns — on-call rotation, escalation chains. But the part that made an emergency submit exceed 30 seconds was not that: it was `dispatchPendingNotifications()` being **unscoped**, and that is a bug, not a design.

The sweep takes the oldest queued deliveries **in the whole system** in id order. So an inline caller paid for every unrelated notification the product happened to owe — and, worse, could fail to send its own: an emergency page queued a moment ago sits behind up to a hundred older rows. R-020 asked for "paged immediately"; flushing everyone else's queue is neither immediate nor the page.

Three changes:
- `dispatchPendingNotifications()` takes an optional `only: { deliveryIds }`. With it, work is bounded by what the caller just wrote. Without it the sweep is still global, which is exactly what the hourly cron is for.
- `notify()` now returns the `deliveryId` it wrote per channel, so a caller can name its own messages. Additive to `ChannelOutcome`.
- All three inline callers pass it: R-020's emergency page, R-025's vendor dispatch, R-026's bid requests. The emergency page also pages recipients through `Promise.allSettled` rather than sequentially — every page is independent, a tenant is waiting on the whole function, and one recipient with a broken record must not stop the others being paged.

**Why this and not more.** Recipient *selection* is untouched: still everyone holding `ticket.write` on the property, still deliberately over-paging. Capping it would be a safety regression dressed as a performance fix — the failure mode of paging one person too few during a gas leak is not symmetrical with paging one too many. R-029 replaces that with a real on-call rotation; this change makes the existing behaviour bounded rather than quietly changing who gets told.

**What pins it.** Four tests in `notifications.test.ts`: that `notify()` reports its delivery ids; that a scoped dispatch sends only those and leaves other queued rows alone; that an explicitly empty set sends nothing rather than falling through to a global sweep (a real hazard — "every channel suppressed" must not be indistinguishable from "no filter given"); and that an unfiltered call still sweeps globally.

## R-027 — Scheduling with entry-notice compliance
**Commit:** `a99ed6c`  ·  **Date:** 2026-08-06

**What it built.** The legal gate on entering somebody's home. Scheduling a visit now reads the property's own jurisdiction rule, checks whether the window gives enough notice, generates and serves the notice when one is required, warns and demands a stated reason when it does not, tells the tenant, and reminds them at T-1 day. Plus the two recorded facts MAINT-05 asks for either side of the visit: a logged permission-to-enter, and a tenant no-show as trip-charge evidence. 22 core tests, 7 e2e.

**This is `rulesFor()`'s first real consumer.** R-010 built the jurisdiction seam and wrote in its own header that every item needing a notice period "calls this — never `prisma.jurisdictionRule` directly, and never a literal number". Nothing had needed one until now. The e2e asserts against the **actually seeded Texas rule of 24 hours**, not a fixture number, so the wiring is proved end to end rather than assumed.

**What it decided.**
- **Warn-and-override, never block.** MAINT-05 asks for exactly this, and it is the honest shape: sometimes the tenant phoned an hour ago asking you to come today. Refusing outright would push staff to stop recording the schedule at all, which loses the evidence trail this product exists to keep. The override writes `entry_notice.overridden` — an action already in `REASON_REQUIRED`, so `recordAudit()` itself refuses to write it without the reason. The requirement is enforced at the writer, not merely in the form.
- **On the refused path, NOTHING is written.** Not the window, not a notice. Saving the schedule and asking for the reason afterwards would leave a scheduled unlawful entry on the record if the second step never happened. Asserted directly.
- **The bases are ordered, and the order is the reasoning.** Emergency first — you do not wait 24 hours to enter a unit that is flooding, and the check must not consult the clock before deciding that. Then tenant permission, because consent outranks the substitute for consent. Then the clock. Each is recorded as the *basis* relied on rather than as "no rule applied", because **why** an entry was lawful is the question asked afterwards.
- **Permission granted after the window opened is ignored.** A grant written down later is a story, not consent; the timestamp comparison is what stops a backdated note being treated as authorization. Its own test.
- **Notice is measured to the START of the window.** A tenant is entitled to the full period before anybody may arrive; letting a long window pad the calculation would quietly shorten the notice.
- **The notice records which rule VERSION produced its period** (`Notice.jurisdictionRuleId`). D-4's whole point: a rule changing next month must not make it impossible to say what the requirement was when this notice went out.
- **The shortfall rounds UP.** Being 1.2 hours short is 2 hours short to anyone reading a warning; rounding down would understate the gap in the one direction that matters.
- **Every generated notice says it is a draft and not legal advice**, per D-4's closing line — asserted in both a core test and the e2e. A generated legal artifact that presents itself as authoritative is worse than none.
- **`entry_notice` is a LOCKED notification category**, so a tenant cannot switch off the message telling them somebody is entering their home. That is what `LOCKED_CATEGORIES` was built for in R-016; this is the first item to lean on it.
- **The T-1 reminder sweeps hourly from the cron tick, not `SCHEDULED_JOBS`** — same reasoning as R-025's no-response timer. It measures a fixed distance in hours from a scheduled instant, which is the same duration everywhere, rather than a calendar-day question; and a daily job would fire at an arbitrary hour relative to the visit, where "tomorrow" sent at 3am is not a reminder anybody reads. An overlapping window plus `notify()`'s own idempotency key gives exactly one reminder per scheduled visit, and a fresh one if it is rescheduled.

**What it left behind.**
- **Service method is `PORTAL` only.** COMM-02 wants state-valid service methods with delivery proof — certified-mail tracking, posted-on-door with a timestamped photo. The `Notice` model already carries `serviceMethod`, `proofDocumentId` and `trackingNumber` for exactly that; choosing among them per notice type is jurisdiction config and belongs with R-053's notice-delivery work, not hardcoded here.
- **No PDF.** `Notice.documentId` is left null; the body text is stored and shown. Generating a print-ready PDF is COMM-02's "print-ready PDF for the paper-preferring tenant" and is its own piece of work.
- **The no-show is recorded, not charged.** MAINT-05 asks for it as "trip-charge/billback evidence", and that is precisely what it is — a timestamped fact. Whether money actually moves is MAINT-07's chargeback flow (R-030) with its own approval path.
- **No tenant-facing reschedule.** The notice tells them to contact us if the time does not work, and that conversation happens in R-017's thread. A self-serve "propose another time" for tenants is not in MAINT-05.

**Bugs found along the way.**
- **React 19 resets uncontrolled form fields once a form action completes — which wiped the schedule the moment the compliance warning appeared.** Hitting the warn-and-override path cleared the window and the reason the user had just typed, so the second submit failed validation on an empty start time. The worst possible form to do this on: the one already telling somebody they have done something wrong. Fixed by echoing the submitted values back through the action's returned state and re-keying the inputs (React reuses an uncontrolled input across renders and ignores a changed `defaultValue`, so the `key` is load-bearing, not decoration). Found by the e2e that filled in an override reason and watched nothing happen.
- **A compliance hint rendered "requires 24hours' notice".** Interpolating a value mid-sentence in JSX dropped the space. Cosmetic, but not on a screen whose job is to state a legal requirement precisely — rewritten as a single template string, which is immune to JSX whitespace rules.
- **`workOrderInclude` did not select `state`/`county`**, so the first `rulesFor()` call from the work order page could not resolve a jurisdiction. Added to the shared include rather than issuing a second query per page — cheap columns on a row already being fetched.

## R-028 — DEFERRED to Phase 3 (not built)
**Commit:** `e86fb6e`  ·  **Date:** 2026-08-06

**Not a build. An owner decision, recorded.** OQ-3 — "in-house maintenance tech, all external vendors, or both?" — was answered **all external vendors**, so R-028's offline tech PWA moves to Phase 3 as **D-17**. The backlog's own risk note 3 had anticipated exactly this outcome and its consequence ("Milestone 2 shortens by an L"), which is why the item carried "(OQ-3 may defer this)" in its title from the start.

**Why deferring is right rather than merely cheaper.** R-028 exists for one person: somebody on payroll standing in a basement with no signal, needing a cached job list, IndexedDB-queued status changes and photos, and a sync-conflict policy. A vendor holding a magic link needs none of that — the link works on any phone, installs nothing, and if signal drops they reload it later, which is precisely the multi-use behaviour D-16 already guarantees. Building a service worker, an offline queue and a merge policy for a persona who does not exist would have been the most expensive wrong turn available in this backlog, and it is an L.

**Dangling dependencies found and fixed while recording it** — the reason this is worth a PROGRESS entry at all rather than a one-line backlog edit:
- **R-030 (verify & close, MVP)** listed R-028 as a dependency. It is soft: verify-and-close needs work orders reaching `WORK_COMPLETE`, which R-025's vendor path already does. Marked struck-through with the reasoning, so nobody later reads a Phase 3 blocker on an MVP item that has none.
- **R-068 (inspection engine, MVP)** said "offline-capable on the same machinery as R-028". There is now no shared machinery to build on. Re-scoped in place: R-068 ships online-only unless its own use case justifies building that machinery itself, with the reasoning stated — staff inspecting a vacant unit usually have a signal; the basement tech was the case that justified it. Left as a decision for whoever picks R-068 up rather than silently resolved.

**What did NOT defer.** MAINT-06's "required completion photo" is already built, in R-025's vendor upload. D-8's PWA groundwork (the manifest, R-018) stands. `assignWorkOrder()` keeps its staff-assignment path, because a manager doing a job themselves is not the same thing as a maintenance employee — and if a tech is ever hired, R-028 returns as a self-contained item with nothing built since R-024 assuming its absence.

## R-029 — After-hours routing
**Commit:** `6456bbb`  ·  **Date:** 2026-08-07

**What it built.** The on-call rota, the acknowledgement that stops the escalation clock, and the chain that fires when nobody answers (MAINT-12, NOTIF-05). `packages/core/oncall` decides who to page: on-call people if anybody is, everybody with `ticket.write` on the property if nobody is. `StaffUser` gained an on-call *window* (`onCallFrom`/`onCallUntil`); `Ticket` gained `acknowledgedAt`/`acknowledgedByStaffId`; `Vendor` gained `emergencyAvailable`. A new five-minute cron (`/api/cron/escalations`) sweeps unacknowledged emergencies and pages the rest of the chain 15 minutes in. Staff go on call from `/account` in one tap; the emergency ticket page grew a response panel with an "I have this" button and the trade's after-hours vendors, each phone number a `tel:` link. Quiet-hours bypass for emergencies was already built in R-016 and needed nothing — the escalation reuses the same `maintenance_emergency` category precisely so it inherits it.

**What it decided.** Recorded as **D-18**; the load-bearing parts:
- **The fallback pages EVERYBODY, and that is the point.** This is R-026's commitment held: narrowing who gets paged is earned by somebody volunteering, never assumed. A lapsed or never-configured rota pages every staff member who can act, and the basis (`on_call_rota` vs `no_rota_paging_everyone`) rides on every escalation so a gap reads as a gap rather than as a working rota.
- **A window, not a boolean.** The failure mode of a checkbox is somebody forgetting to clear it and being paged at 3am for a month; the failure mode of *that* is they mute the channel. A window lapses on its own, into the safe direction. A half-configured window (a start with no end) is read as *not* on call, deliberately.
- **No ranked escalation chain, and no column for one.** MAINT-12 says "page → SMS → call → backup" — three of those four are channels the notification engine already sends at once. An `escalationRank` column was written, then cut before commit: it would have ordered a list that is paged simultaneously, which is a field somebody maintains believing it changes something. Build tiering the day escalation actually waits between tiers.
- **"Escalate once" has no column behind it.** The sweep reads the answer off the sends themselves (`emergency-escalation:{ticket}:{staff}` idempotency keys). A `lastEscalatedAt` column would be a second, weaker copy of a fact the notification log already carries, free to disagree with it.
- **Acknowledgement is deliberately NOT `firstResponseAt`.** R-023's triage stamp measures a triage decision; this measures somebody taking responsibility for a page. Conflating them would let ordinary daytime queue work stop the escalation clock, which is exactly the silent failure this item exists to prevent. First acknowledgement wins — a second person clicking thirty seconds later has not responded thirty seconds later.
- **Its own cron entry, at five minutes.** Fifteen minutes cannot be measured by an hourly tick: an emergency reported at 09:05 would escalate at 10:00. Running the whole hourly job twelve times an hour to fix that would be the wrong end of the problem.
- **On-call is self-service only.** Putting yourself on call is volunteering and needs no permission; the row written is always the actor's own, so this action *cannot* put somebody else on call. A rota screen where one person schedules the team needs a real permission and is not this.
- **OQ-10 is no longer a hard gate.** The backlog was right that inventing a human protocol produces an escalation path nobody answers — so this encodes none. It ships the mechanism and lets the real arrangement be whatever it is.

**What it left behind.**
- **The emergency-vendor flag has no management screen.** It is set from the emergency ticket itself, which is the moment anybody actually learns "this plumber picks up on a Sunday". R-079 (vendor management, Phase 2) owns trades, W-9, COI and preferred/fallback lists, and this flag moves there with them.
- **No phone-call channel.** MAINT-12's chain names one; the notification engine has SMS, email and portal (D-15, and the SMS driver itself is still behind an unapproved 10DLC campaign). A voice leg is a provider integration, not routing logic.
- **No rota scheduling ahead of time.** You go on call now, for 12/24/72 hours. Scheduling next weekend's shift is the UI that OQ-10's answer would justify.
- **Escalation reaches everybody not already paged, in one go.** Waiting between tiers, and a "you are next up" pre-warning, are what a ranked chain would add — see D-18 for why not yet.

**Bugs found along the way.**
- **The on-call and acknowledge buttons did nothing before React hydrated.** Both were `onClick` handlers, which are inert until the JavaScript arrives — and a dead "I have this" button at 3am on a bad connection means the chain escalates to the owner while somebody is already driving to the property. Rewritten as real `<form action>` submissions with `useActionState`, so they work whether or not hydration has happened. Found because the e2e clicked immediately after `goto` and the database never changed, while the assertion above it passed against a sloppy regex — two failures hiding each other.
- **The escalation sweep redid full work every five minutes, forever.** Each tick re-resolved the rota and attempted a write per recipient per channel for every still-unacknowledged emergency in a 24-hour window — all correctly deduplicated, none of it free (288 rounds for one unacknowledged ticket). Fixed with a single up-front query for which tickets have already escalated; the integration test's runtime went from growing-per-test to flat, 39s to 17s.
- **A crashed test run had poisoned `sms-intake.test.ts` for every run since.** Its fixture claimed a hard-coded phone number; a run that died before its cleanup left an active tenant holding it, so every later run saw two candidates for that number and — correctly — refused to route, failing eight tests. The routing feature working against its own fixture. Phones are now unique per run.
- **A one-in-three flaky gate: four test files each swept the GLOBAL event outbox concurrently**, so one worker could claim another's `(event, consumer)` pair between its two dispatches. `dispatchOutbox()` gained the same `only` filter `dispatchPendingNotifications()` already carries, and every test now dispatches only its own events. Four consecutive clean full runs after.
- **Deleting a test property started failing** once the sweep wrote `ticket.escalated` audit rows against it: the delete cascades a SET NULL onto `AuditLog`, which the append-only trigger refuses. The evidence trail outliving its fixtures is the product working, so the fixture yields — properties are deactivated, not deleted.

## R-030 — Verify & close
**Commit:** `99d59e4`  ·  **Date:** 2026-08-09

**What it built.** The end of the maintenance lifecycle (MAINT-07). When work is marked complete — by staff, or by a vendor through R-025's magic link — the tenant is asked "is it fixed?" through the notification engine, and answers in one tap from their own portal. "Yes" moves the job to VERIFIED. "No" reopens it, clears the completion stamp, and raises a `workorder_reopened` Task. A PM then closes it with the invoice total, a normal-wear / tenant-caused / unknown flag, and a refusal if the tenant has just said it is not fixed. That invoice total is the only place the money is entered: the property page's new **Maintenance spend** section is a projection of the work-order rows, and the work-order page shows the assigned vendor's reopen rate at the point where somebody is deciding whether to send them again.

New `WorkOrderVerification` table; `reopenedAt`/`reopenCount`/`closedAt`/`closedByStaffId` on `WorkOrder`. The money columns (`actualLaborCents`, `actualMaterialsCents`, `invoiceCents`) already existed from R-026 — this item is what finally reads them, which is why the migration adds no money column.

**What it decided.** Recorded as **D-19**; the parts a later session must not silently reverse:
- **The vendor is captured on the ANSWER, not read off the work order later.** This is the whole cost of MAINT-07's "captured from day one". A reopened job is normally reassigned, so by the time anybody runs a vendor report the work order names whoever eventually fixed it — attributing the failure to them is exactly backwards, and unrecoverable once the column has moved. There is a test that reassigns mid-flow and asserts the reopen stays with the first vendor.
- **The cost is typed once and never again.** No maintenance-spend table; the property roll-up computes from the work orders through `jobCostCents()`, the same function R-026's re-approval check uses, so "what did this cost" cannot mean two numbers on two screens. `jobCostCents` takes the invoice where there is one rather than summing all three — a vendor who itemises their own invoice would otherwise be double-counted on every job.
- **The two close refusals are deliberately asymmetric.** A current-round "no" blocks the close outright and is checked BEFORE any bookkeeping complaint: a missing invoice is a data-entry problem, a live complaint recorded as resolved is a legal one. Silence does not block — a tenant who never replies must not hold a work order open forever — but `workorder.closed` records `unverified: true` and the page states it permanently.
- **A $0 close requires somebody to say it was free.** A warranty callback really can cost nothing; a job closed at nothing because a form was left blank is a hole in a property's cost history that surfaces a year later as spend that is quietly wrong.
- **A verification is its own row per round.** Columns on the work order would let April's "yes, fixed" erase March's "no, still leaking" — and the earlier answer is the evidence that the reopen was justified.
- **The rating is optional and stays optional.** MAINT-07 says one tap. A required rating puts a second decision between a tenant and the word "yes", and the reply rate is the entire value of the feature.

**What it left behind.**
- **`INVOICED` status and MAINT-09's vendor-visible invoice lifecycle** (received → approved → paid, tolerance-based auto-routing) belong to R-079's vendor management. The enum value exists and is unused; the flow goes WORK_COMPLETE → VERIFIED → CLOSED.
- **No chargeback.** `tenantCaused` is set here and posts nothing. R-031 owns the ledger write, the notice and the approval path — deliberately, because that is money leaving a tenant's balance.
- **No QuickBooks export.** R-042 owns the mapping, and D-19 states the constraint it inherits: map from these rows, never ask anybody to re-key them.
- **The reopen keeps the vendor assigned.** A decline (R-025) clears the vendor because that vendor is not doing the job; a reopen does not, because the PM needs to see whose work came back while deciding who to send. The job goes to SUBMITTED with a Task.
- **Maintenance spend shows the 10 most recent jobs.** The full per-property spend report is R-050's, and the section says so.

**Bugs found along the way.**
- **The verification link was a relative path.** `/portal/maintenance/<id>` in an SMS is not a link — it is a string a tenant cannot tap, on the one message whose entire value is the tap. Now built through `authUrl()` like every other outbound link, and deliberately not from the request Host header for the reason that function already states.
- **Both success confirmations vanished before anybody could read them.** The tenant's panel and the PM's close panel are shown or hidden by a *server-side* condition, and `revalidatePath()` re-renders the page the instant the write lands — so the notice living in each component's own `useActionState` disappeared with the panel. The tenant tapped and watched the question evaporate with no acknowledgement; the PM closed a job and lost the "the tenant never confirmed this one" caveat entirely. Both are now rendered from the row: the portal keeps the answer on screen until there is genuinely a new question, and a closed work order carries a permanent Closed section stating the cost and whether anybody confirmed it. Better than the toast either way — the caveat is what somebody needs to see months later, not for two seconds.
- **Five private copies of the same P2002 predicate.** `isUniqueViolation` had been re-declared in task creation, thread get-or-create, the job runner, the notification recorder, and this item's verification write — all identical, all doing the same load-bearing insert-then-catch job that is the only get-or-create shape safe under concurrency. Extracted to one module and the copies deleted.
- **An existing properties e2e broke on a substring match.** Adding a "Maintenance spend" heading made `getByRole('heading', { name: 'Maintenance' })` resolve to two elements. Pinned to `exact: true` rather than renaming the section — a locator that silently matches more as the page grows is the defect.

## R-032 — Work-order comms threading
**Commit:** `caee425`  ·  **Date:** 2026-08-09

**What it built.** The single merged, exportable timeline COMM-06 asks for: tenant thread, vendor thread and staff notes hanging off one work order. A staff member can now reply to the tenant or the vendor directly from a work order's own page (tagged to that job at send time), add an internal note nobody outside the office ever sees, and attach an inbound text that arrived before anyone knew which job it was about. A vendor gets a real, work-order-scoped conversation from their magic-link page — the first time vendors have had any free-text messaging at all, R-025 having shipped only structured actions (accept/decline/propose/upload). The work order page renders every entry (the original report, tenant/vendor/staff messages, notes) in one chronological list, and `/workorders/[id]/timeline` downloads it as a plain-text transcript.

**What it decided.** Recorded as **D-20**:
- **The tenant's thread stays continuous, unchanged from R-017/COMM-01.** Individual `Message` rows are tagged with `ticketId`/`workOrderId` at send time instead of fragmenting the conversation per ticket — additive, costs nothing when absent, and does not re-litigate a decision COMM-01 already settled.
- **The vendor gets a genuinely separate, work-order-scoped thread** (`vendor:<id>:workorder:<id>`), alongside the unchanged property-scoped thread inbound SMS still routes into. D-16 already scopes a vendor's magic link to one job; a vendor running two concurrent jobs for this operator — ordinary for a preferred trade — must not have both conversations arrive mixed into one thread. The new thread is PORTAL-only by construction: offering SMS on it would let a reply land in the *other* thread instead, silently splitting one conversation into two nobody reads together.
- **"Attach an existing message to a job" cannot be an UPDATE to the message.** `Message` has been append-only since R-017 — its trigger rejects every UPDATE, not only DELETE. Discovered by building it the update way first and watching it fail in exactly that way in e2e. Fixed with a new insert-only `WorkOrderMessageLink` join table; the original evidence is never rewritten, and a unique constraint on `messageId` keeps one message from being claimed by two jobs. `Message.ticketId`/`workOrderId` were also corrected from Prisma's default `SET NULL` to `RESTRICT` — a `SET NULL` cascade would itself require the UPDATE the trigger refuses, so `RESTRICT` is the only truthful constraint (and never expected to bind, since neither a Ticket nor a WorkOrder is ever deleted in this product).

**What it left behind.**
- **The PDF transcript is not built here.** COMM-05/R-052 owns "timestamped PDF transcript with delivery metadata... the packet you hand an attorney, an adjuster or a judge." This item's export is the honest raw material for that — plain text, chronological, attributed — deliberately not duplicating a later, larger item.
- **An ordinary inbound text after the first still has no automatic incident.** R-021's SMS threading is one continuous conversation per tenant, not a sub-thread per ticket, because tenants do not context-switch cleanly over SMS — there is no signal at receive time saying which job a reply is about. The "attach" feature is the deliberate human step that closes this gap; a fully automatic version was not attempted, and inventing a heuristic (nearest by date, most recent open job) would file evidence on a guess, the exact failure mode `decideRoute` already refuses elsewhere in this codebase.
- **No undo on an attach.** `WorkOrderMessageLink` has no delete path. A mis-attached message stays attached; a correction would need its own small feature, not built here.

**Bugs found along the way.**
- **The vendor's message box was unreachable until they had already responded to the job.** It lived inside the same conditional branch as the accept/decline/upload flow, so a vendor still deciding whether to take the job — exactly when they might have a clarifying question — had no way to ask one. Moved outside that branch; messaging is now available from the moment the link opens.
- **Three textareas had no accessible label**, caught by the WCAG AA e2e run rather than by hand: the internal-note form, the vendor-reply form, and the vendor's own message box all rendered a bare `<textarea>` with no `<label>`. Fixed with `sr-only` labels matching the pattern the rest of the form library already uses.
- **A read-after-write race in the "attach" e2e test itself**, not the product: the test's Prisma connection is separate from the one the server action committed through, and against Neon's pooled connections a read immediately afterward can land a beat early — the same gap `properties.spec.ts` already documented for its own create-property test. Fixed by polling instead of a single read.

## R-033 — Lease records
**Commit:** `7825322`  ·  **Date:** 2026-08-10

**What it built.** The `Lease` entity finally has a product around it: a scoped list (running tenancies first), a create form that forks on where the tenancy came from, and a detail page carrying the parties, the term, the deposit, the utility matrix and the lifecycle. Occupants and guarantors are two separate lists, not one list with a role column. A guarded status machine in `packages/core/leases` owns every transition; activating a lease occupies its unit immediately and ending one frees it. Notice to end the tenancy is recorded with **who gave it**, without changing the status. And the whole RISK-08 inherited-acquisition path exists: an inherited lease starts with its deposit position UNKNOWN, its three outstanding items are raised as `Task` rows in the one queue, and each is shown on screen with the consequence of leaving it open rather than as a bare checklist.

New enums (`LeaseOrigin`, `DepositTransferStatus`, `NoticeParty`) and columns (`origin`, `depositTransferStatus`, `depositTransferNote`, `estoppelConfirmedAt`, `activatedAt`, `noticeGivenBy`), plus a partial index over inherited leases whose deposit is still unestablished — the acquisition worklist, which should be short and shrinking.

**What it decided.** Recorded as **D-21** and **D-22**:
- **No `NOTICE_GIVEN` status.** A tenancy under notice is still running — rent due, repairs owed, entry notice applying. As a status it would have to be remembered by every "is this lease in force?" check in the product, and the one that forgot would stop charging rent to somebody who still lives there. It is a fact about an active lease, and renders as a badge *alongside* the status pill, never instead of it.
- **Nothing leaves ENDED or TERMINATED.** A tenancy that restarts is a new lease. The old one's dates, rent and signatures are the evidence R-071's deposit disposition is defended with.
- **TERMINATED demands a reason, enforced at the audit writer.** It has its own action (`lease.terminated`) sitting in `REASON_REQUIRED`, so `recordAudit` itself refuses a termination with no stated reason — the same call R-024 made splitting `workorder.denied` from `workorder.approved`. A conditional "required only when the target is TERMINATED" is not something that set can express.
- **An inherited lease starts UNKNOWN, never the NOT_APPLICABLE default** — and the gap check *also* treats NOT_APPLICABLE on an inherited lease as unanswered. Deliberately defended twice: that default is correct for the ordinary path, so an inherited lease inheriting it would sit looking settled while representing an unquantified liability. In most states the current owner owes the deposit back at move-out whether or not the seller ever handed it over.
- **"The seller kept it" is an answer, not an absence.** What matters is that somebody established the fact, and when.
- **The outstanding items are Tasks in the one queue (D-9), raised URGENT and re-raised daily** while they stay open. Going quiet after one ask is how this survives to move-out.
- **Activation couples to the unit.** R-009's `unit.auto_make_ready` job already named this item as the process that would take over; it stays as the backstop for a fixed term nobody touches. The MAKE_READY transition is guarded on the unit still being OCCUPIED, so one marked DOWN for a renovation is not quietly reclassified as ready to turn.
- **Rent due day is capped at 28.** A lease due on the 30th has no due date in February, and every downstream billing anchor (R-034) would have to invent one.

**What it left behind.**
- **No lease generation or e-signature.** R-063 owns the attorney-drafted template, merge fields, addenda and the e-sign adapter. The `PENDING_SIGNATURE` status exists and is reachable; what drives it is R-063's.
- **No billing.** Activating a lease does not open a Stripe subscription — that is R-034, and D-11 is explicit that Stripe is the system of record for money.
- **`utilityResponsibility` stays JSON.** Its shape is a lease-template concern (R-063); normalizing it before there is a template to normalize against would be guessing at the schema.
- **No roommate-change flow.** Removing the last occupant from a running tenancy is refused outright; RISK-10 owns the departing-tenant release, the replacement screening and the ledger continuity.
- **No renewal automation.** LEASE-09's 120/90-day flags and the rent-increase notice check are its own item; `mtmRentCents` is recorded here for it to read.

**Bugs found along the way.**
- **A plain function passed from a Server Component to a Client Component**, which took the whole lease detail page down at runtime. `changeStatus={(to) => action.bind(...)}` looked like an ordinary prop; only a `'use server'` export has an identity the client can call back to. `npm run build` did not catch it — every lease e2e test did. Fixed by binding each transition's action server-side into the offers array.
- **The demo seed's `--reset` had been broken** since the first time anybody used a demo property: deleting a property cascades a `SET NULL` onto its `AuditLog` rows, which the append-only trigger refuses, and a second collision waited behind it on `JobRun`'s `(jobType, COALESCE(propertyId,''), businessDate)` unique key. That a used property cannot be deleted is the product working — the evidence trail outlives the entity — so the reset now *retires* audited properties (deactivated and renamed out of the way) and deletes only untouched ones. `JobRun` is machine bookkeeping rather than evidence (D-9's own split), so it is deleted outright.
- **The seed's inherited tenancy was not actually marked inherited.** R-013 has demonstrated an "inherited-at-acquisition" lifecycle since it shipped, but with nowhere to record it the demo showed a tenancy indistinguishable from every other one. It now carries `origin: INHERITED` and `depositTransferStatus: UNKNOWN`, so the path this item built is visible in the demo. The in-notice lease likewise now records that the *tenant* gave notice.
- **A create-redirect wait that matched its own starting URL.** `waitForURL(/\/leases\/[a-z0-9]+$/)` also matches `/leases/new`, so it resolved instantly and handed back `"new"` as the lease id — the identical trap `maintenance-phone-log.spec.ts` documented for its own redirect, hit again because the lesson lived in a comment in one spec rather than anywhere reusable.
- **Two leaked browser contexts in R-032's spec, and the flake they were causing.** `comms-threading.spec.ts` opened vendor contexts and never closed them, unlike every other spec that opens one. They survived their tests and held live pages against the shared browser for the rest of the run. This is what had been producing the intermittent full-suite failure chased across three sessions: the failing test's own page snapshot showed *the vendor magic-link page from another spec entirely*. Closing them took the suite from "1 flaky" to clean.

## R-034 — Stripe Billing foundation
**Commit:** `c4889ab`  ·  **Date:** 2026-08-10

**What it built.** The D-11 keystone. `packages/core/billing` holds three pure modules: real Stripe webhook signature verification (HMAC-SHA256 over `${timestamp}.${rawBody}`, several `v1` candidates for secret rotation, a replay window), the billing-cycle anchor computed in **property-local** time, and the event → projection-intent mapping. `apps/web/lib/billing` holds the `BillingProvider` seam with a simulated adapter, provisioning that opens a Customer and Subscription when a lease goes live, and the webhook pipeline: verify → claim → project → acknowledge. A new public `POST /api/webhooks/stripe` reads the raw body before anything parses it. New `ProcessedStripeEvent` table, keyed on the Stripe event id. The lease page grew a Billing section that says out loud when the provider is not real Stripe.

**What it decided.** Recorded as **D-23** and **D-24**:
- **The seam is split by DIRECTION, not by feature.** No Stripe credentials exist — the multi-LLC KYB the backlog flags at R-001 has not cleared. D-15 refuses to ship an untested outbound HTTP client; R-021 established that a *receiver* is the opposite case, because it can be exercised completely with synthetic requests. So everything inbound is real and tested exhaustively, and everything outbound is a four-method interface with a simulator behind it.
- **The simulator mints Stripe-shaped ids on purpose**, so every column, index and screen downstream is exercised against realistic values. That makes them indistinguishable by inspection — so the *label* is the only thing that tells them apart, and it is on the audit entry for every provisioning and on the lease screen in as many words.
- **Claim before project, with the event id as the primary key.** Stripe retries until it gets a 2xx and does not promise exactly-once delivery; `LedgerEntry` is append-only, so a double projection is money nobody can correct by editing. Claiming afterwards leaves a window where two concurrent deliveries both project. There is a test that fires three concurrent deliveries and asserts exactly one lands.
- **Every decided outcome returns 2xx — including "ignored".** Anything else has Stripe retry forever and fills the dashboard with failures that are not failures. Ignored events are recorded with a stated reason.
- **`charge.*` is excluded alongside `invoice.*`** — the same money one layer down. Projecting both would double-count every payment.
- **The anchor holds its LOCAL hour across daylight saving**, and two properties billing on the same local day get different anchor instants. A server computing either in UTC would be wrong for both.
- **Provisioning is triggered by activation and is separately resumable.** Each Stripe id is written to our row the moment it exists, so a failure between the customer and the subscription leaves no orphan in Stripe. It never throws into the caller: activation is a tenancy fact and must not be undone because a billing provider was unreachable.

**What it left behind.**
- **No Stripe HTTP client.** One assignment in `lib/billing/provider.ts` plus a four-method class, when there is an account to call. Deliberate — see D-23.
- **The money rules are R-035's.** This projects what Stripe reports; late fees and their state-cap clamp, proration, RUBS allocation, payment-allocation order and `daysPastDue` are core's under D-12 and belong to R-035 and R-040. A projector that started deciding amounts would be D-12 inverted.
- **No reconciliation sweep.** R-035 owns "reconciled against Stripe on a schedule with drift alarmed"; there is nothing to reconcile against yet.
- **No subscription lifecycle.** Pause, resume, cancel on move-out and the Billing Runs screen are R-036's. `customer.subscription.*` events are deliberately not in the handled list.
- **`Payment.channel` is `OTHER` for everything projected.** The invoice event does not say whether it was ACH or card; R-037 owns the tenant-facing flow that knows the rail.
- **SetupIntents are created but nothing calls it yet.** PAY-02's saved-method UI is R-039's; the seam is here so that item is a screen rather than a screen plus a provider change.

**Bugs found along the way.**
- **Four `ON DELETE SET NULL` foreign keys pointing at an append-only table**, latent since R-002 and found the first time a test wrote ledger rows and then tried to clean up after itself. `LedgerEntry`'s `leasePayerId`, `chargeId`, `paymentId` and `reversesId` all declared a cascade that could never run — the append-only trigger rejects every UPDATE, so deleting a referenced Payment raised "LedgerEntry is append-only" instead of clearing the reference. Changed to `RESTRICT`, which states the truth: a row the ledger points at cannot be deleted, which is the intended behaviour under D-11 and now fails with a message naming the real reason. Exactly the fix R-032 applied to `Message.ticketId`, for exactly the same reason — the second time this pattern has surfaced, which suggests checking the remaining nullable FKs into append-only tables the next time one is touched.
- **A test of mine made an existing flake worse before fixing it.** `notifications.test.ts` has two tests that dispatch the *global* notification queue; with the suite grown to 1,011 tests they intermittently failed because the default 100-row batch filled with other suites' rows. Raising the batch to 5,000 fixed that and immediately caused a *timeout* instead, because the sweep then genuinely sent thousands of notifications twice inside a 5s limit. The real fix was to notice that only one of the two tests needs the global path at all: "sends once even when dispatched twice" proves the same guarantee scoped to its own deliveries, and the one test that genuinely exercises the cron's unfiltered sweep got the large batch and a timeout to match.
- **The lease e2e's cleanup broke the moment activation started provisioning billing** — a `LeasePayer` now pins the lease it belongs to. Fixed in the spec; noted there that it is deletable only because nothing in that file projects a payment, since a `LedgerEntry` pointing at a payer is `RESTRICT` and would correctly refuse.

## R-035 — Ledger projection + money rules in core
**Commit:** `6d31f61`  ·  **Date:** 2026-08-10

**What it built.** D-12's centre of gravity, all of it pure and exhaustively tested. `packages/core/ledger` holds four modules: the late-fee decision (grace period, all four fee types, and **both** statutory ceilings), payment allocation across outstanding charges in the jurisdiction's own order, the balance and running-balance statement over the projection, and drift detection. The app layer adds scoped ledger reads, a reconciliation sweep wired into the hourly cron that alarms into the append-only trail, and a Ledger panel on the lease page written to be read by a judge — plain language, running balance on every line, nothing editable.

Not one statutory literal was added. Every grace day, rate and ceiling is read from `JurisdictionRule` through R-010's resolver, per D-4.

**What it decided.** Recorded as **D-25**, plus the calls inside the money rules:
- **Both caps, and the LOWER binds.** A jurisdiction can express its late-fee ceiling as a flat amount, a percentage of rent, or both. Reading whichever is non-null first, or taking the higher, charges above a limit somebody wrote into a statute.
- **Null is not zero.** A jurisdiction with no cap is not a jurisdiction with a cap of zero — conflating them silently stops late fees in states that permit them.
- **The computed amount is kept alongside the charged one.** "We computed $95 and charged $50 because the state caps it" is the sentence that defends the charge; a bare $50 does not.
- **A percentage fee is charged on what is OUTSTANDING**, not the full rent. Charging a tenant who paid most of the rent a percentage of the whole is charging on money already received.
- **Grace is inclusive and daily fees exclude it.** A 2-day grace means a fee on day 3, and 9 days late with a 2-day grace is 7 chargeable days.
- **Allocation order comes from the jurisdiction, and the default is RENT-FIRST.** Applying a partial payment to fees before rent leaves rent unpaid, which is what a pay-or-quit notice is served on — and in several states accepting rent after serving one voids it. Where a state is silent, the default is the reading least likely to produce an indefensible notice.
- **An overpayment is returned as unapplied, never swallowed.** It is the tenant's money, and the ledger panel says "in credit" rather than showing a negative that reads as a debt.
- **The reconciliation says what it did not check.** See D-25 — the internal sweep cannot compare amounts honestly and cannot see an event that never arrived, and both gaps are reported rather than implied.

**What it left behind.**
- **No RUBS allocation feature.** `allocate()` has existed since R-002 and is the math; attaching the underlying bill and documenting the arithmetic per bill is R-042's, alongside recurring charges.
- **No proration feature.** `prorateRent()` is the math and R-034 already reports when a first period is partial; computing and pushing the invoice item is R-042's.
- **Nothing pushes an invoice item to Stripe yet.** These rules compute; R-040 (late fees) and R-042 (proration, recurring) own pushing the result, and D-12 is explicit that they must — Stripe never generates a jurisdiction-dependent number.
- **No aged-delinquency buckets.** The 0–5 / 6–15 / 16–30 / 30+ report is R-044's; `daysPastDue` is the primitive it will use.
- **The external reconciliation is unbuilt**, gated on the same Stripe account D-23 defers. The seam and the comparison both exist; only the caller with an API to ask is missing.

**Bugs found along the way.**
- **`daysPastDue` reported a charge ONE DAY PAST DUE on its own due date** — a late fee charged a day early, on every property west of UTC, every month. Latent in R-002's money module since it was written, with a doc comment claiming a contract the implementation did not honour: it took two `Date` objects and read them with the LOCAL getters, so a Prisma `@db.Date` (UTC midnight) compared against a real timestamp came out a day apart. R-035 was its first caller and found it before it had one. Fixed by changing the signature to take `BusinessDate` strings — the same unambiguous type `packages/core/scheduling` has carried since D-3 — which makes the error unrepresentable rather than merely tested against.
- **A reconciliation that reported its own test suites' debris as drift.** The billing and webhook tests deleted their `ProcessedStripeEvent` rows on cleanup while their `LedgerEntry` rows survived, because the ledger is append-only and cannot be deleted — manufacturing, permanently, exactly the `orphan_entry` condition the new check exists to detect. The check was right; the cleanups were wrong. They now leave the event log alone, which also mirrors the production invariant: the log outlives, like the ledger it describes.
- **I wrote a placeholder helper that always returned `undefined`** while reaching for an amount to reconcile against, and only noticed on re-reading that there is no independent amount on this side at all. The fix was not a better helper but admitting the check cannot be made — which is now D-25 and a stated gap rather than a function that looks like it does something.


## R-036 — Subscription lifecycle
**Commit:** `b0534ca`  ·  **Date:** 2026-08-10

**What it built.** The half of D-11 that pays off. `packages/core/billing/lifecycle.ts` decides what a lease's state means for its subscription — provision, re-price, pause, resume, cancel, or nothing — and the app layer performs it. A **real Stripe driver** now exists alongside the simulator, selected by whether `STRIPE_SECRET_KEY` is set. Lease activation provisions; a lease ending cancels, effective at the move-out date; a rent change re-prices. A nightly billing sweep in the cron makes Stripe agree with every live lease, and the **Money screen** became the Billing Runs screen the backlog asks for: per-payer outcomes, failures first, with a re-sync action on both it and the lease page.

**What it decided.** Recorded as **D-26** and **D-27**:
- **A real Stripe driver, test mode only, and it REFUSES a live key at construction.** A live Stripe account turned out to be reachable, and the owner authorised test-mode use — which answers D-15's objection rather than overriding it: a driver that can be executed is worth writing. The refusal is a throw, not a warning, because the difference between `sk_test_` and `sk_live_` is four characters in an environment variable copied between machines by hand. It also means a live key does not silently fall back to the simulator, which would let somebody believe billing was running when it was not.
- **Every write carries an idempotency key derived from the fact, never randomly.** The most likely network failure is a request that times out *after* Stripe processed it; a retry without a stable key creates a second subscription that bills the tenant twice every month thereafter.
- **`proration_behavior=none` on every price change.** D-12 keeps any amount a statute could touch in core. Stripe's proration is built for mid-cycle plan changes, not a calendar rent changing at a renewal boundary.
- **"The tenancy is over" outranks everything else in the decision.** Checking the rent first would re-price a subscription that should have been cancelled — billing somebody who has moved out, at a new rate. There is a test for exactly that ordering.
- **A pause is `mark_uncollectible`, not `void`.** PAY-12's hold means we stop *collecting*; the debt is still real, and voiding the invoice would erase it.
- **Null from Stripe means "we have not asked", not "Stripe has nothing".** The decision refuses to act on a difference it cannot see, rather than guessing.
- **The simulator reports what it was told** (D-27) — see the bug below.

**What it left behind.**
- **No test key is configured yet**, so the Stripe driver has not been executed against the account. Everything up to the HTTP call is tested; the call itself is not. Setting `STRIPE_SECRET_KEY=sk_test_…` in `.env.local` is what closes that, and the driver refuses anything else.
- **Nothing sets `collectionPaused` yet.** R-047 owns PAY-12's per-tenant switches; R-036 only makes Stripe agree with the flag once something sets it.
- **No renewal integration.** R-065's rent-increase flow will change the rent and this will follow it; the wiring is already the same path an ordinary edit takes.
- **The Billing Runs screen reads our own sync breadcrumbs, not Stripe's invoice events.** The backlog phrases it as "reading Stripe's invoice events"; those arrive through R-034's webhook pipeline and land in the ledger, which the lease page already shows. What this screen adds is the subscription layer underneath — where Stripe has stopped agreeing with the lease.
- **The rent roll and aged delinquency** named on the same screen are R-044's.

**Bugs found along the way.**
- **The simulator agreed with the lease by construction, making the rent-change path dead code.** Its `getSubscription` read `lease.rentCents` — our own current row — so it could never disagree, and `update_price` would only ever have run against real Stripe. Found by a test that should have passed and did not. Fixed by recording what we last successfully *pushed* (`LeasePayer.stripeAmountCents`, D-27), which reproduces the one behaviour that matters about an external system: it remembers what it was told. Written after the push, never before, so a failed push cannot leave us believing it landed.
- **The nightly sweep was untestable because it swept everything.** Correctly bounded at 200 payers, but the dev database now holds hundreds from earlier items, so the test timed out. Fixed by making the sweep scopeable per property — which is also genuinely useful operationally, since re-running one property should not wait on the portfolio.
- **A third global-notification-sweep timeout**, same class as the two fixed in R-034 and for the same reason: the suite has grown to 1,116 tests and an unfiltered dispatch inside a 5s timeout now has real work to do. Scoped it to its own deliveries; the global path keeps its own dedicated test. Worth noting the pattern — every time this suite grows meaningfully, an unfiltered global sweep somewhere becomes the slowest thing in a test that never meant to exercise it.
- **Two flaky e2e tests, both waiting on a server action.** `expect` still carried Playwright's 5-second default while the tests themselves were allowed 60 — so any assertion waiting on a `<form action>` round trip plus `revalidatePath` plus an RSC re-render could time out under two projects at five workers with nothing actually wrong. Raised to 15s, which is the whole class rather than the two tests that happened to show it.

## R-036b — Golden Path 1 repair
**Commit:** `52c88e2`  ·  **Date:** 2026-08-10

**What it built.** Nothing new. This item is the repair of four defects found by walking **Demo checkpoint 1** end to end for the first time — the checkpoint the backlog defines after R-032 and that nothing had ever run. All four sat in items already marked ✅, and the checkpoint as written did not complete.

- **`VERIFIED` was a black hole.** The status existed in the enum and in the write that sets it, and in neither of the two lists that read it: `OPEN_STATUSES` in `lib/workorders/queries.ts` and `ACTIONABLE_STATUSES` in `packages/core/vendors/access.ts`. So the tenant tapping "yes, it's fixed" removed the work order from `/workorders`, kept it out of Maintenance spend (which filters `CLOSED`), and **killed the vendor's magic link** — typically the same evening the vendor finished and days before the invoice arrives. `vendorMayUpload`'s own comment nine lines below the list says a vendor keeps uploading through completion "because the invoice usually lands after the work is marked done". It didn't.
- **Nothing ever closed the `Ticket`.** `createWorkOrder` moves a ticket to `CONVERTED`, which is correctly an *open* status — R-021's SMS intake threads an inbound text onto an open ticket rather than raising a duplicate. But nothing moved it off, so the ticket stayed open forever and every later text from that tenant threaded onto the fixed job: no new ticket, no `ticket.created`, no triage Task, no SLA clock, no habitability scan. Their November "no heat" would have arrived as a reply on August's water heater. The tenant's portal also read "Work scheduled" on a job that was closed and paid.
- **The entry window was parsed in the server's timezone.** `scheduleEntry` read a `datetime-local` string with a bare `new Date(...)`, which uses the Node process's zone — UTC on Vercel. That instant is then rendered **property-local** in the notice body. A PM booking Tuesday 9:00 AM on a Texas property served a legal entry notice saying *"between 4:00 AM and 6:00 AM"*. The right helper (`wallClockToUtc`) already existed and was already used correctly one directory over in `lib/comms/actions.ts`; R-027 simply didn't reach for it. Five display sites on the work-order page had the mirror-image bug.
- **The invoice bypassed the approval ceiling.** `reapprovalCheck` had exactly one caller — `recordActuals`, the path where a PM hand-types labour and materials. Under D-17 (all external vendors) that is the rare path. The normal one — a vendor uploads their invoice, a PM closes behind it — wrote the amount straight onto the work order with no check at all. Owner approves $600, plumber uploads $2,400, job closes at $2,400. MAINT-04's third criterion never fired on the path most jobs take.

Also added: a **`workorder_ready_to_close` Task** on the tenant's "yes". A "no" raised a Task and a "yes" raised nothing, which sounds right until you notice that "yes" is where a job stops being maintenance and starts being money — the invoice is coming, the cost has to be recorded, and nothing else in the system will ever mention the work order again.

**What it decided.** Recorded as **D-28**: a demo checkpoint is an acceptance gate for the milestone above it and gets walked end to end when that milestone closes, not when convenient. Findings become backlog items in the milestone that owns them. Also settled in code:

- **`VERIFIED` is open, `CLOSED` is where the vendor link dies.** The tenant's answer is not the vendor's business and must not end their access. Money recorded is the end of the job; a tenant's confirmation is the middle of it.
- **`PENDING_APPROVAL` is actionable for a dispatched vendor.** Found by my own new test failing: pushing an over-ceiling job back for approval dropped it out of the actionable set, so *the act of submitting an invoice destroyed the link the invoice arrived on*. Not reachable before dispatch, because there is no vendor on the work order to mint a token for.
- **An over-ceiling invoice is BANKED, not refused; the CLOSE is refused instead.** Turning the vendor away at upload means the invoice gets phoned in and re-keyed by hand — the outcome D-6 and D-19 both exist to prevent. Take the document, take the number, move the *job* to `PENDING_APPROVAL`, raise a Task in the one queue (D-9), and refuse the close until somebody signs. The vendor is told nothing about the ceiling: not their business, and "needs approval" invites the chasing phone call this whole path avoids.
- **The ticket closes on the LAST work order, not this one.** A ticket can spawn several jobs (the leak and the cabinet it ruined); closing on the first would be the same bug pointed the other way.
- **`readyToCloseTask` is ROUTINE whatever the job's priority was**, unlike `reopenWorkOrder` which carries priority through. An emergency that has been fixed and confirmed is bookkeeping; paging it as urgent trains people to ignore the urgent queue. A reopen is the opposite case — the emergency is still live.
- **The timezone e2e assertion computes its expected value with `Intl` directly**, not with the app's own `utcToWallClock`, so a bug in that helper cannot make the test agree with it. D-27's principle applied to a test rather than a simulator.
- **`vendorMayMarkComplete(status)` is a core rule, not a status literal in the action.** Widening the actionable set meant `markWorkComplete`'s single `=== 'WORK_COMPLETE'` guard was no longer sufficient, and the vendor page had a second copy of the same literal. Both now call one function with one test.

**What it left behind.** The operator walk produced eight further findings, all filed as **R-032a–R-032e** rather than fixed here, because each is a feature-sized gap rather than a defect in shipped behaviour:

- **R-032a — nobody is subscribed to the vendor.** Decline, accept, message, mark-complete and invoice-upload produce no notification and no Task. A decline is *worse than silence*: `sweepUnansweredDispatches` filters `vendorRespondedAt: null`, so a vendor who never answered raises a redispatch Task and one who said no raises nothing. R-032 built the vendor's only free-text channel and left it unread.
- **R-032b — what the vendor is not told**: the confirmed schedule is never passed to the vendor page (they still read "we'll confirm" after a window was booked and legally noticed); the tenant's **pet warning and entry permission** are collected by R-019, validated, and written nowhere, so the vendor opening the door is never told there is a dog; and `markWorkComplete` requires no completion photo though D-17 says R-025 already made it required.
- **R-032c — one-tap verification is not one tap.** The SMS link hits `requireTenant`, which redirects to an **email-only** login with no return-to. For the SMS-only tenant — the exact persona R-021 exists for — it is a dead end.
- **R-032d — the vendor link's 3-day TTL** is tuned for a same-week job; routine work booked out a week and month-end invoices both land after it dies.
- **R-032e — `jobCostCents` and `actualTotalCents` disagree** (invoice-wins vs `max`), and `jobCostCents`'s comment claims they are the same rule. Both behaviours are defensible for their own purpose; the comment is not, D-19 assumes one number, and R-042's export will have to pick.

Also amended: **Demo checkpoint 1's own text.** It said the tenant "texts a photo", which R-021 deliberately deferred (MMS needs an outbound Twilio call D-15 defers). The deferral stands; the checkpoint was describing a path that was never built, so it now says to run it through the portal wizard.

**Bugs found along the way.**
- **I introduced one and the test caught it.** Sending an over-ceiling job to `PENDING_APPROVAL` dropped it out of `ACTIONABLE_STATUSES` — the exact class of defect this item exists to fix, committed while fixing it. Caught because the new e2e test asserted the vendor still sees "Invoice received" after uploading, rather than stopping at the database assertions that had already passed.
- **And I introduced a second one, caught by grepping for the seam rather than by a test.** Widening `ACTIONABLE_STATUSES` made `VERIFIED` and `PENDING_APPROVAL` reachable on the vendor page, where `markWorkComplete` guarded only against `WORK_COMPLETE` — so a vendor could have flipped a tenant-confirmed job back to `WORK_COMPLETE`, discarding the confirmation and re-asking a tenant who had already answered, or wiped the approval gate their own invoice raised. Found by sweeping every `WORK_COMPLETE` literal in the codebase after the first one, which is the check D-28 is really asking for: **when you add a value to an enum, find every list that reads it.** Both call sites now use `vendorMayMarkComplete()`.
- **`Task.priority` is the `Priority` enum** (`EMERGENCY`/`URGENT`/`ROUTINE`), not a task-specific one. I wrote `NORMAL` from habit; Prisma rejected it at runtime, not at typecheck, because `createTask` takes a `string`.
- **Two flaky e2e tests in the R-036 run**, both waiting on a server action. `expect` still carried Playwright's 5-second default while tests were allowed 60, so any assertion waiting on a `<form action>` round trip plus `revalidatePath` plus an RSC re-render could time out with nothing wrong. Raised to 15s in `playwright.config.ts` — the class, not the two tests that happened to show it.

## R-037 — Tenant payments
**Commit:** `b0c7ad7`  ·  **Date:** 2026-08-10

**What it built.** PAY-01, and the resolution of the question that had been blocking Milestone 3 since D-11 was taken. A tenant can now open the portal, see what they owe and what it is made of, choose how to pay, and pay it — with the card fee disclosed in money before the choice, and Stripe-hosted fields throughout so no card or bank number ever reaches this product.

- **`packages/core/payments`** holds every rule: which collection method allows a partial payment, whether a payer may switch and when, what a card actually costs, and how much a payer may send right now. All pure, all tested (31 tests).
- **Collection method is per payer** (D-29) and lives on `LeasePayer`, spelled exactly as Stripe spells it so there is no mapping layer to drift.
- **The Stripe driver gained four calls**: collection method on subscription create and on change, an open-invoice read, and a one-time PaymentIntent.
- **The webhook pipeline now tracks pending → settled.** `payment_intent.processing` records money in flight; settlement moves the same row and only then moves the ledger.
- **A `/portal/pay` screen**, second in the tenant nav — balance largest, itemisation underneath, ACH first, card fee recomputed as they type.
- **A receipt** on settlement, through the notification engine (R-030's rule), splitting rent from fee.
- **A staff switch action** that asks Stripe before deciding, pushes before writing, and demands a reason.

**What it decided.** Recorded as **D-29**, which answers **OQ-11** and unblocks Milestone 3, and **D-30**, which states the market this product serves:

- **Collection method is per payer and it switches.** Stripe cannot do autopay and partial payments on one subscription. Option (b) — autopay wins, partials recorded as offline payments — was rejected because it makes partial payment a staff-mediated path, and the tenants most likely to pay in parts are the ones least able to reach an office during business hours; a Must story satisfied only by somebody else typing it in is not satisfied. Option (c) would have been most of D-2 rebuilt behind a Stripe façade.
- **The switch is guarded, conservatively, and refuses far more than a naive version would.** A payment in flight outranks an open invoice in the refusal order, because the in-flight payment's outcome decides whether the invoice is owed at all. `openInvoiceAmountCents: null` — "we have not asked" — refuses, exactly as R-036's lifecycle decision treats an unread subscription. The failure being avoided is a tenant billed twice for one month's rent.
- **THE CARD FEE IS GROSSED UP, NOT NOMINAL.** A processor takes its percentage of the total it charges, not of the rent underneath it, so `amount + rate×amount + fixed` does not recover the cost — the owner is left short by the rate applied to the fee itself. About $1.32 a month per tenant on $1,500: invisible per payment, real across a portfolio, and permanently invisible if nobody does the algebra. `total = (amount + fixed) / (1 - rate)`, rounded up. This also stays inside card-network surcharging rules, which cap a surcharge at the cost of acceptance — grossing up recovers exactly that and not a cent more.
- **Whether the fee may be charged at all is jurisdiction configuration** (D-4), not a literal. `cardSurchargePermitted` and `cardSurchargeMaxBps` are versioned rule fields. **No rule configured means not permitted** — charging a fee we cannot point at a rule for is the wrong way to be wrong.
- **A payment_intent event belonging to an invoice is NOT projected.** It is the same money `invoice.payment_succeeded` already reports, and projecting both would credit every subscription payment twice — in an append-only ledger where the fix is a reversing entry somebody first has to notice is needed. This is the same trap that keeps `charge.*` off the handled list, and it now has its own test. `processing` is the deliberate exception: it is the only event that says money is in flight, and it moves no balance.
- **Money in flight moves no balance, but it does reduce what we ask for.** The ledger stays honest about what has arrived; the pay screen stays honest about what to ask for. Crediting an ACH debit early would tell a tenant they are square, suppress a late fee and possibly cancel a notice — on a payment that may never arrive.
- **The receipt is sent on settlement, never on submission.** It is the document a tenant will later hold up to prove they paid.
- **Every number is recomputed server-side.** The action trusts neither the amount nor the fee the page rendered — both are derived again from the ledger and the jurisdiction rule at the moment of payment, because the form was rendered at some earlier moment and a charge may have landed since.
- **The United States is the only market** (D-30). Stated because the product already assumed it everywhere — two-letter state codes, ACH as the free rail, a Texas rule seed — and nobody had written it down, which is how a later session adds currency scaffolding for a need that never arrives. `usd` stays a literal in the three places it appears. **US-only is emphatically not single-jurisdiction**: D-4 stands, every statutory number remains versioned per-state configuration, and R-037b exists precisely because one state's surcharge law differs from another's.
- **An overpayment is refused rather than accepted.** A credit balance has to be allocated somewhere and the allocation order is jurisdiction configuration (R-035); taking money this flow cannot correctly place is worse than declining it.

**What it left behind.**
- **Retail cash (PAY-01's cash-preferring tenant) has no driver — now R-037a, gated on a vendor decision.** Checked Stripe's documentation directly rather than assuming: Stripe has **no US retail-cash rail at all**. Konbini (convenience-store cash) is Japan-only and OXXO is for customers in Mexico, so the pattern exists at Stripe and is simply not offered here. The real options are third parties — PayNearMe, VanillaDirect, CheckFreePay — each needing a contract, a fee schedule and a settlement shape that cannot be designed before one is picked. The seam is built and waiting: `PaymentRail` and `PaymentChannel` both carry `RETAIL_CASH`, and the tenant sees the option as unavailable *with a reason* rather than not seeing it. No simulated driver, per D-15. **This is the one part of PAY-01 that is not built.** R-038 carries the cash-preferring tenant until it lands.
- **Cash App Pay was considered and rejected** (owner call, same day). It is US and would have been a small addition — one more `payment_method_type` on the PaymentIntent flow that already exists. Rejected because it would have to be **absorbed rather than passed through**: it is funded by the customer's Cash App balance *or a linked debit card*, we are never told which, and several states bar surcharging debit specifically. Stripe reaches the same conclusion from the other direction — its own surcharging product supports cards and Apple Pay only and applies no surcharge to anything else. It is also a wallet, not cash at a store, so it would not have closed PAY-01's actual gap. Worth recording that it is *not* a rail we are missing by oversight.
- **The card surcharge cannot yet tell debit from credit — now R-037b.** The pass-through applies to any `card` payment, but Tex. Bus. & Com. Code §604A.003 and its equivalents bar surcharging debit specifically, and the funding type is not knowable at the moment the fee is quoted and disclosed. Stripe's own answer is a surcharge-provider app (Yeeld, InterPayments) computing a compliant amount from brand, funding type and issuing country. Flagged in the Texas rule's own `notes` as well, because it needs the attorney review D-4 already requires rather than an engineering call.
- **No autopay enrolment UI.** R-039 owns PAY-02 — the chosen day, the T-2 pre-debit notice, ACH returns and dunning. `debitsAutomatically()` exists here for it to call.
- **No saved-payment-method management.** `createSetupIntent` has existed since R-034; nothing yet lets a tenant add or replace a card. R-039 and R-043 need it.
- **Nothing writes a `Charge` row on a schedule yet.** The pay screen itemises whatever charges exist; PAY-03's "when the configured day arrives, rent charges post automatically" is R-040/R-042's.
- **The switch action has no screen.** It is a server action with its guard and its audit entry, called from nowhere — the lease page's billing panel is where it belongs and R-043 is the natural item. Written now because the guard is the load-bearing half of D-29 and belongs with the decision.
- **`cardSurchargePermitted` cannot express the Texas rule exactly.** Tex. Bus. & Com. Code §604A.003 bars a surcharge on debit and stored-value cards specifically while permitting it on credit; Stripe reports `card` without distinguishing them at the point this product decides the fee. Seeded as permitted, with the nuance written into the rule's own `notes` for the attorney review D-4 already requires.

**Bugs found along the way.** None in shipped behaviour. Two things the type system and the tests caught while building:
- Adding `collectionMethod` to `SubscriptionInput` failed typecheck at both call sites, which is exactly what that field being required is for — a payer re-provisioned after a cancelled subscription now keeps the mode somebody deliberately put them on, rather than being silently returned to autopay and debiting an account a tenant had asked us to stop debiting.
- The first e2e run failed on a `getByText('Rent')` that also matched the new "Pay rent" nav link and page heading — the same over-loose-selector trap as the `waitForURL` one already in CLAUDE.md, and fixed the same way, by scoping to the region.

## R-037c — Test isolation: portfolio-wide staff bleed
**Commit:** `595789b`  ·  **Date:** 2026-08-10

**What it built.** Nothing. A one-line fixture change that took the unit suite from failing roughly one full run in two to three consecutive clean runs of all 1,187 tests.

**The bug.** `escalation.test.ts` failed intermittently with `Inconsistent query result: Field staffUser is required to return data, got null` from `onCallStaffForProperty()` — in a file with no connection to the one causing it. Ruled out first: there were no orphaned `StaffAssignment` rows (checked directly), the `staffUserId` foreign key is `RESTRICT`, and R-004 deactivates staff rather than deleting them, so **production cannot reach this state**.

The cause was two correct behaviours meeting concurrency. `auth/scoping.test.ts`'s duplicate-grant test creates a **portfolio-wide** assignment — both scope columns NULL — because that is precisely what it exists to test. `onCallStaffForProperty()` matches portfolio-wide grants for every property, also correctly: somebody granted the whole portfolio really is a paging candidate everywhere. So while that test runs, its staff member is a candidate for every concurrently-running suite; and when it deletes them, it does so in the window between the two queries Prisma issues to resolve the required `staffUser` relation.

**What it decided.** `active: false` on that one fixture. `onCallStaffForProperty` already filters `staffUser: { active: true }`, so an inactive user is invisible to paging and the bleed closes at its source. It changes nothing the test asserts — duplicate-grant protection is a database unique index over the scope columns, which has no opinion about whether the person is still employed.

Three alternatives were rejected, and the reasons matter more than the choice:
- **A role without `ticket.write`** would work by coupling one spec's fixture to another spec's query — a fix that breaks silently the day the permission list changes.
- **Serialising the two files** hides the cause rather than removing it, and the next portfolio-wide fixture reintroduces it somewhere else.
- **A database schema per test file** is the genuinely correct answer and remains the right thing to build if this recurs. It was not worth real infrastructure for a one-line problem, and saying so is a deliberate deferral rather than an oversight.

**What it left behind.** The class of problem, not this instance. Any future fixture that creates a portfolio-wide grant reintroduces it, and nothing enforces the rule — there is no test asserting that test fixtures stay scoped. This is the **fourth** distinct cross-file interference this suite has produced (after the global outbox sweep, the hard-coded phone number and the leaked browser contexts), which is a pattern worth naming: the suite shares one database, and every fixture that reaches beyond its own property is a fixture that can reach into somebody else's assertions. Per-file schemas are what actually ends it.

## R-038 — Offline payment recording
**Commit:** `062f309`  ·  **Date:** 2026-08-10

**What it built.** PAY-05: a check, money order or cash handed over in person, recorded by staff in a few seconds from the lease page, applied against what the tenant owes, and — the part that is not obvious — **pushed to Stripe so it stops collecting**.

- **`packages/core/payments/offline.ts`** holds the rules: which channels are somebody-at-a-counter, what each one requires, and whether an amount can be applied to what is actually outstanding. 20 tests.
- **`markInvoicePaidOutOfBand()` and `getOpenInvoice()`** on the billing provider, both implementations.
- **`recordOfflinePayment()`**, gated on `ledger.adjust` rather than `lease.write`.
- **A four-field form** on the lease page, every field pre-filled with the common answer.

**What it decided.** Recorded as **D-31**:

- **An offline payment is pushed to Stripe, not merely recorded here — and the reason is operational, not architectural.** The obvious reading of D-11 makes this a purity question. It is not: **Stripe is driving collection.** A payer on `charge_automatically` gets debited again on the billing day; one on `send_invoice` keeps an open invoice and keeps being dunned. A check recorded only in our own ledger means a tenant who paid gets chased for the same rent and eventually charged twice. Telling Stripe is required, and it happens to be exactly what D-11 wanted.
- **Stripe first, our row second.** If the push fails, nothing is written at all. A `Payment` row we hold while Stripe goes on debiting is worse than no record, because the staff member walks away believing it is handled.
- **The offline detail stays ours.** Stripe cannot hold which numbered instrument arrived or which member of staff took it. PAY-05 is explicit that a cash payment with no named recipient is an unauditable cash payment, and R-002's schema already carried `checkNumber` and `receivedByStaffId` for exactly this. The `LedgerEntry` still arrives only through the webhook, so there remains **one** way money enters the projection.
- **`ledger.adjust`, not `lease.write`.** Recording money that arrived off the rails is the most forgeable action in the product — there is no processor on the other side to disagree — so it sits behind the permission R-004 already treats as privileged.
- **SETTLED, not PENDING.** A check in hand is money received. Whether it later bounces is a separate future event (a reversal, which R-039's NSF handling owns), and holding it pending would leave the tenant's balance wrong for days after they actually paid.
- **Backdating is allowed; post-dating is refused.** A check handed over on Friday and typed in on Monday was paid on Friday, and late-fee arithmetic runs off the date it arrived rather than the date somebody found time to record it. A future date is refused because a post-dated check is not money yet.
- **Fifteen seconds is a design constraint, not a nice-to-have.** PAY-05 names it, and the alternative to a fast path is a shoebox of checks and a spreadsheet — which is the failure this product exists to replace. Four inputs, all above the fold, each pre-filled with the answer that is right most of the time: today, a check, and the full balance.

**What it left behind.**
- **Part-payments are REFUSED, and that is a stated gap rather than a design — now R-038a.** Stripe's out-of-band mechanism settles the whole invoice, so applying half of one would mark the rest paid and write it off silently: the tenant would owe nothing and nobody would notice. Somebody arriving at the counter with half the rent in cash is an entirely real situation, so the refusal says so in words and tells staff to take the money and hold the record. The likely route is a customer-balance credit, which Stripe applies to the *next* invoice finalized — note "next", which is the wrinkle, because it does not settle the invoice already in front of you. **It needs the real Stripe account to design against**, since the mechanics turn on invoice/balance interactions the simulator cannot faithfully reproduce and D-15 forbids guessing.
- **Deposit batching is not built.** PAY-05 names it; it is a genuinely separable reporting feature over `Payment` rows that already carry everything it needs (channel, date, receiver), and it belongs with the rest of the money reporting rather than bolted onto a recording form.
- **No printable receipt for an offline payment.** The tenant gets the ordinary payment receipt once the webhook posts, which is the same evidence by a different route. A counter receipt printed at the moment of handover is a different artifact for a different purpose, and nobody has asked for it in a way that says what it must contain.
- **The whole path is untested against real Stripe**, like everything else outbound (R-036's stated gap). `paid_out_of_band` is verified against Stripe's documentation — the Invoice object carries `amount_paid_out_of_band` as a distinct field from `amount_paid` — but no call has been executed. The simulator's `getOpenInvoice` reports the lease balance as a single synthetic invoice, which is **coarser than production**, where Stripe issues one invoice per period. That difference is stated in the code: against the simulator the part-payment refusal fires on the whole balance, where production would fire on the period.

**Bugs found along the way.** None in shipped behaviour. One in a test I wrote and caught immediately: a dynamic `import()` nested inside a ternary, which is nonsense that happened to typecheck. Rewritten as a plain top-level import.

## R-039 (part) — Returned payments
**Commit:** `0a02ef9`  ·  **Date:** 2026-08-10

**What it built.** The half of PAY-02 with teeth: what happens when a payment comes back. **This fixed a real bug in shipped code.**

An ACH debit gives what Stripe calls "instant provisional access" and takes **up to four business days** to confirm — so everything downstream of a payment runs, for days, on money that may not arrive. Stripe emits the *same* `invoice.payment_failed` event for a first decline and for a return days later. The shipped projector treated both as "nothing has changed about what is owed" and moved no ledger, which is correct for a decline and wrong for a return: the credit stayed in place, and **a tenant appeared to have paid rent they had not**. PAY-02 names exactly this failure — "no downstream action that was triggered by the provisional payment remains incorrectly in effect."

- **`packages/core/payments/returns.ts`** — `returnAction()` reads the event against our own `Payment` row, `nsfFeeFor()` computes the fee under its statutory cap, `reversalAmountCents()` decides direction. 13 tests.
- **The projector** now reverses a settled payment that came back: `Payment` → `REVERSED`, and a positive `REVERSAL` entry pointing at the entry it undoes.
- **`JurisdictionRule.nsfFeePermitted` / `nsfFeeMaxCents`**, seeded for Texas at 30 USD (Tex. Bus. & Com. Code §3.506).
- **A `payment.returned` notice** on the locked SMS category.

**What it decided.** Recorded as **D-32**:

- **The same Stripe event means two different things depending on history**, and the row we already hold is what distinguishes them. Reading only the event, a decline and a return are indistinguishable.
- **The reversal amount comes from the settled payment, not the invoice.** A partial payment that returns must give back exactly what it gave; an invoice total is a different number.
- **A second delivery is ignored, not reversed again.** Stripe promises neither ordering nor exactly-once delivery, and in an append-only ledger a double reversal is money nobody can correct by editing.
- **The return notice is on a LOCKED SMS category** — a tenant cannot turn it off. Believing rent is paid when it is not is how somebody ends up in eviction proceedings over a bank error.
- **The notice deliberately says nothing about a fee.** Under D-12 a jurisdiction-dependent amount is computed in core and pushed to Stripe as an invoice item; nothing raises that charge yet, so quoting a fee here would promise a number that does not exist.
- **The NSF fee is a lease term first and a statutory ceiling second.** A lease that is silent charges nothing, even where the state permits a fee — inventing one the tenant never agreed to is how a fee becomes unenforceable at the moment somebody needs to enforce it.
- **What "no stale downstream state" means today, stated honestly**: the balance is currently the only such state, because late fees are computed from the ledger on demand (R-035), so restoring the balance restores the correct fee position automatically. Nothing else keys off a payment yet. When something does — a notice cancelled on payment (R-062) — it has to unwind in the same place, and the code carries that reminder rather than pretending machinery exists.

**What it left behind — the item is 🟡, not ✅.** The enrolment half of PAY-02 is **R-039a**, and it is genuinely blocked rather than skipped:
- **No tenant-facing saved-payment-method flow.** `createSetupIntent` has existed since R-034 and still has no caller, so **a tenant cannot switch autopay on today**. It is Stripe Elements against a live key and cannot be meaningfully tested without one (D-15) — guessing at it would produce exactly the code-that-looks-finished D-15 was written about.
- **No tenant-chosen debit day, and no owner "require full balance" switch.**
- **No T-2 pre-debit notice.** PAY-02 requires it; `debitsAutomatically()` exists for it to key off.
- **The NSF fee is computed but never posted.** `nsfFeeFor` is tested; nothing pushes the invoice item.

**Bugs found along the way.**
- **The one this item exists for**, above — found by reading Stripe's ACH documentation rather than by a failing test, which is worth noting: no test could have caught it, because the tests asserted the behaviour that was wrong.
- **I updated the recorded outcome and not the returned one.** The projector logged `payment_returned` while returning `payment_failed` to its caller — two spellings of one fact, caught immediately by the new test. Now a single `outcomeDetail` feeds both.
- **Three new tests exceeded the 5s default** because the return path walks the real pipeline twice and sends a notice on the way through. Given explicit 20–30s timeouts with the reason stated, per the convention in CLAUDE.md — the dispatch is scoped to its own delivery ids, so this is genuinely the test's own work rather than a global sweep.

## R-040 — Late fees
**Commit:** `1fc241a`  ·  **Date:** 2026-08-10

**What it built.** PAY-04. A nightly, per-property, property-local job assesses late fees on overdue rent from versioned jurisdiction configuration, clamps them to the statutory ceiling, and pushes each one to Stripe as an invoice item. Staff can waive a fee as a credit with a reason and a named approver, and the waiver-pattern report ships alongside the waiver rather than after it.

- **`lateFeeDeltaCents()`** in core — the arithmetic that makes a scheduled assessment safe.
- **`addInvoiceItem()`** on the provider, both implementations. This is the mechanism **every** jurisdiction-dependent charge now uses, and it is also what R-039a needs to post the NSF fee it currently only computes.
- **`assessLateFees()`** plus a `SCHEDULED_JOBS` entry at 6am local, after the 4am billing sweep.
- **`Charge.assessedOnChargeId`**, linking a fee to the rent that produced it.
- **`waiveCharge()`** and **`waiverPatternByTenant()`**.

**What it decided.** Recorded as **D-33** and **D-34**:

- **A scheduled fee charges the DELTA, never the cumulative figure.** `lateFeeFor()` answers "what is the total owed as of this date" — correct for a daily-accruing rule, and a trap for anything on a schedule. Charging it nightly turns a $10/day fee into **$60 owed by day three instead of $30**. Three behaviours fall out of the delta for free: a flat fee charges once and then zero forever, a daily fee charges one day's worth, and a fee at its statutory cap produces zero because the cumulative figure stops moving — no separate "have we capped out" state to maintain.
- **A waived fee still counts as assessed.** Waiving forgives a fee that was correctly charged; it does not say the fee was never owed. Excluding it would re-charge it the next night and quietly undo the waiver.
- **The delta is never negative.** A waiver leaves more assessed than the cumulative figure allows, and the answer is to charge nothing further — not to invent a credit. Reversing an over-charge is a deliberate act with a reason on it, not an arithmetic side effect.
- **The waiver-pattern report ships WITH the waiver** (D-34), and reports tenants who were never forgiven anything. Fair housing is the reason: waiving fees for some tenants and not others, along lines correlating with a protected class, is a discrimination pattern regardless of intent. An operator cannot avoid a pattern they cannot see, and building the waiver first with the report "later" is exactly how a year of uneven waivers accumulates before anybody looks. A report of waivers alone would show only generosity and hide its distribution — the tenants at zero are half the pattern. It reports a pattern, never a verdict.
- **A waiver is a credit, not a deletion**, and it is pushed to Stripe as a negative invoice item. Waiving only in our own tables would leave Stripe still collecting it.
- **No configured rule means no fee** — not a default fee, and not an error. D-4's whole point is that a statutory number comes from configuration; inventing one for an unconfigured state is how a product charges an unlawful fee in a market nobody has set up yet.
- **Late fees are assessed on RENT only.** A late fee on a late fee is compounding by another name.
- **The rule version is stamped onto every fee.** "What did the law say on the day we charged it" is the first question in a dispute and cannot be reconstructed from today's row.
- **The description defends the charge.** "Late fee — 12 days past due (flat $50; capped at $30.00)" survives a dispute in a way that "Late fee" does not, and it is the audit reason too.

**What it left behind.**
- **No screen for either.** The assessment is a scheduled job and the waiver is a server action with its guard, its Stripe credit and its audit entry — neither has a UI yet. The waiver belongs on the lease ledger panel and the pattern report belongs with the money reporting (R-044/R-050), and putting them there is a small amount of work that wants those screens to exist first.
- **The report attributes a fee to the first tenant on the lease.** A joint tenancy shares one ledger, so a per-tenant split would invent an attribution the money does not have. For spotting a pattern, what matters is that the household appears once — but this is a stated simplification, not an accident.
- **Nothing notifies the tenant that a late fee was assessed.** PAY-04's "the tenant is notified" is unbuilt; the engine and the pattern from R-039's return notice are both right there, and the reason it is not done is that the fee posts to Stripe and arrives on the ledger through the webhook, so the honest moment to notify is when it lands rather than when we push it.

**Bugs found along the way.**
- **The audit layer caught me.** I put the reason inside `after` instead of the top-level field, and `ledger.adjusted` is on `REASON_REQUIRED` — it threw with "why is the point of the record", which is exactly the guard doing its job. Four tests failed and told me immediately.
- **I exported a query from a `'use server'` module.** `waiverPatternByTenant` started life in `waivers.ts`, which publishes it as a client-callable endpoint taking arbitrary property ids with no permission check. Moved to `waiver-report.ts` behind `server-only`. This is the second time this exact mistake has happened (the first was `policyFor` in R-037), which makes it worth naming as a pattern: **a read that takes a scope argument does not belong in a `'use server'` file.**

## R-040b — The charge half of the ledger
**Commit:** `db07d97`  ·  **Date:** 2026-08-10

**What it built.** One handled event, and it closed a bug that made **every balance in the product wrong**.

**The bug.** Nothing in the application ever wrote a `CHARGE` ledger entry. The only two writers were the payment projection and the return reversal — both of them negative or reversing. Balances everywhere are computed from `LedgerEntry` alone, so the ledger was **single-entry**: payments and no charges. A tenant who paid rent went progressively further into credit every month, and `/portal/pay` told them *"You are $1,500 ahead. Nothing is due right now."*

R-034 excluded `invoice.finalized` from `HANDLED_EVENTS` deliberately, with a stated reason: an unpaid invoice "changes nothing about what is owed that `invoice.payment_succeeded` will not say more precisely later." That is wrong in one word. **`payment_succeeded` reports money ARRIVING; it never reports rent becoming OWED**, and nothing else in the pipeline said the second thing.

**How it was found, and why that matters.** Not by a failing test — by asking what actually writes a ledger row in application code, as opposed to in a fixture. **Every test in the suite creates `CHARGE` entries by hand**, so the tests construct a state the application itself cannot produce, and all of them passed against a ledger that could never balance in production. That is a class of blind spot worth naming: a fixture that builds what the app cannot build will hide the fact that it cannot.

**What it decided.** Recorded as **D-35**, which amends D-11's event list:
- **`invoice.finalized`, not `invoice.created`.** A draft invoice has not been presented to anybody and can still change; finalization is the moment it becomes a bill.
- **`amount_due`, not `total`.** `amount_due` is what the invoice actually asks the tenant for after any credit balance Stripe has applied. Projecting `total` would put a charge on the ledger the tenant was never asked to pay. A finalized invoice with nothing due is ignored for the same reason.
- **No `Payment` row.** A bill is not a payment. Nobody has paid anything.

**Bugs found along the way** — two more, both mine, both in the same twenty lines:
- **The charge was typed `PAYMENT`.** The projector mapped `refund → REVERSAL` and everything else to `PAYMENT`, so the new kind balanced correctly and read as a lie on the statement. Caught by asserting on the row's type rather than only on the balance, which is the assertion that was worth writing.
- **`writePayment` created a `Payment` row in the `REFUNDED` state** for a charge, because `charge_posted` fell through its ternary chain. It would have shown up on the tenant's payment history as a refund that never happened.

**What it left behind.** ~~Nothing new.~~ **That line was wrong, and a code review caught it the next day** — see R-040c below. Posting a charge without its retraction left a voided invoice stranding a permanent debt on an append-only table, and the new entry named no `Charge` row, so a paid late fee showed as outstanding forever. Both are now fixed. The claim is left struck through rather than edited away because "I declared this closed and it was not" is the useful record.

## R-040c — Acting on the code review
**Commit:** `cba1b5c`  ·  **Date:** 2026-08-11

**What it built.** Four fixes, all from a `/code-review` pass over R-040b. Every finding was real; two were worse than reported, and three were defects I had introduced the day before and declared closed.

**1. A voided invoice stranded a permanent debt.** `invoice.finalized` posts a positive CHARGE to an append-only table, and nothing handled `invoice.voided` — so once a bill was withdrawn, the debt could never come off. Not a dashboard-only edge case: `pauseSubscription({ behaviour: 'void' })` is one of our own three pause behaviours, described in our own adapter as "for a period where nothing is genuinely owed". Pausing a tenancy that way would have left every paused month as a phantom balance. Fixed with a `charge_voided` kind writing a negative REVERSAL — D-11's rule as written, corrections are reversing entries.

**This is the lesson worth keeping**: I added a way to CREATE a debt without the way to RETRACT it, in the same session I spent quoting D-11 at every other decision. A new positive entry needs its negative counterpart designed at the same time, not later.

**2. The charge entry named no `Charge` row.** Three readers ask "what is still outstanding on this charge" from its own ledger entries — `outstandingCharges()`, the tenant pay screen, and the late-fee delta arithmetic. With `chargeId` null they all answered "all of it", permanently: a tenant who paid a late fee would see the balance drop to zero and the same fee still itemised underneath as outstanding, forever. Fixed with a round trip — `addInvoiceItem` stamps our charge id into Stripe's invoice-item metadata, Stripe copies it onto the invoice line, and the finalization projection reads it back and writes one linked entry per charge. Subscription rent has no `Charge` row and lands unlinked, which is correct rather than a gap.

The late-fee job now creates its `Charge` row **before** pushing to Stripe, so the id exists to stamp. A failed push leaves a charge with a null `stripeInvoiceItemId` — recoverable and visible — whereas pushing first would put an invoice item in Stripe naming a charge id that does not exist.

**3. The reconciliation was keyed on the wrong thing, and worse than reported.** `MONEY_MOVING_EVENTS` matched Stripe event *types*, but the same type produces different outcomes depending on history: `invoice.payment_failed` writes a REVERSAL when it is an ACH return against a settled payment (R-039) and nothing when it is a first decline. Keyed on the type it said "no row expected" in both cases — so **a lost reversal, the most serious drift there is, was invisible to the check built to catch exactly that.** It also missed R-037's uninvoiced `payment_intent.succeeded`. Now keyed on the projection kind the pipeline actually recorded, with the old type set kept as a fallback for legacy rows that carry no detail, because under-reporting drift is the failure that matters.

**4. The decisions log had not been a table since D-15.** A blank line before each new row split every decision from D-15 to D-35 into its own one-row table. The review caught D-35 because that was all it could see; twenty rows were affected, across several earlier sessions. Fixed, and worth noting as a docs defect that silently accumulated because nobody rendered the file.

**What it decided.** Nothing new — these are corrections, not decisions. D-35 stands as written, with `invoice.voided` now its stated counterpart.

**What it left behind.**
- **The review only saw 40 lines.** With everything committed and pushed to `main`, `origin/main...HEAD` was empty and the tool fell back to the last commit. It found four real defects in that sliver, which is an argument for reviewing the rest rather than a clean bill of health. The projection pipeline has now been changed five times and has never been reviewed as a whole.
- **The linked-entry loop writes one row per charge inside a transaction.** Fine for an invoice with a handful of lines; an invoice with hundreds would want a `createMany`. Not built, because no path produces one yet.

## R-040d — First real execution of the Stripe driver
**Commit:** `a66d2cf`  ·  **Date:** 2026-08-11

**What it built.** A smoke test that calls Stripe for real, and the fix for the bug it immediately found.

The owner put a test-mode key in `.env.local`, which closed the caveat standing since R-036: the outbound driver had **never once been executed**. Everything up to the HTTP call was tested; the call itself was not. `apps/web/lib/billing/smoke.stripe.test.ts` now walks the whole surface against test mode — create customer, create subscription with the anchor in seconds, read it back, switch collection method both ways, read the open invoice, change the price, cancel. It reads its key from `STRIPE_SMOKE_KEY` (which nothing pins) and **skips itself when that is absent**, so it is inert for everybody who has not deliberately opted in and the 1,235-test suite stays offline and deterministic.

**The bug it found on the first run.** `setCollectionMethod` to `send_invoice` returned a 400:

> *Missing email. In order to create invoices that are sent to the customer, the customer must have a valid email.*

**Stripe refuses invoiced collection for a customer with no email**, and D-29's switch guard did not know. Every unit test asserted we sent the right request; only Stripe could say the customer was not ready to receive it. Everything else in the lifecycle passed first time — the anchor in seconds, `days_until_due` present on `send_invoice` and absent on `charge_automatically`, `proration_behavior=none`, the price change, the cancel.

**What it decided.** Recorded as **D-36**, amending D-29:
- **`switchDecision` refuses `send_invoice` for a payer with no email**, with a message telling staff what to do about it. Moving *back* to autopay needs no email — autopay pulls from a saved method and sends nothing, so the constraint is one-directional, and a payer who moved onto invoicing must not be trapped there.
- **The collision is stated, not solved.** D-10 and R-021 exist for the tenant who has no email and pays by check. D-29 puts partial payments on `send_invoice`. A tenant who needs to pay in parts is disproportionately a tenant with no email. So **the person most likely to need a payment plan is the one Stripe will not invoice** — and R-038 refuses offline part-payments too, which means today there is no path at all for them. The refusal says what a staff member can do; it does not pretend the gap is closed.

**What it left behind.**
- **The collision above.** It wants an owner decision: collect emails as a condition of a payment plan, or make R-038a's offline part-payments the path for emailless tenants. The second is more faithful to D-10.
- **The smoke test creates objects in the Stripe test account** and only cleans up the subscription it made. Test-mode customers are disposable, and deleting them needs an API method the driver has no other reason to carry.
- **Nothing exercises the INBOUND half against real Stripe.** Webhooks need a tunnel or a deploy for Stripe to reach, and `STRIPE_WEBHOOK_SECRET` is deliberately still unset. The inbound pipeline is exhaustively tested against synthetic signed payloads, which R-021 established as the right line.

**Bugs found along the way.** I reintroduced the decisions-table blank line **immediately after fixing twenty instances of it** in R-040c, in the very next edit to the same file. Caught by re-running the same check. Worth naming: a defect class is not fixed until the thing that produces it changes, and here that thing is me appending rows with a leading newline.

**Postscript (2026-08-11).** Preparing the Twilio 10DLC registration surfaced a defect unrelated to Stripe: **nothing in this product handles `STOP`**. Carrier-level opt-out overrides our notification engine entirely, including the locked categories a tenant is not allowed to switch off — so a tenant who texts STOP stops receiving entry notices while our log continues to record them as sent. A delivery record that can be silently false is the sharpest possible defect for a product whose premise is that the evidence trail is the product. Filed as **R-040e**; it is not a blocker for 10DLC registration, since Twilio satisfies the carrier requirement at the platform level.

## R-041 — The waiver screen and the fair-housing report
**Commit:** `f4e4f20`  ·  **Date:** 2026-08-11

**What it built.** The two screens R-040 left behind, and the reason it mattered: **the nightly job had been assessing late fees with no way to waive one.** `waiveCharge()` was written, tested, and callable by nothing — so a fee could be raised automatically and not forgiven. A waive control now sits on the lease page, and PAY-04's waiver-pattern report sits on `/money`.

**What it decided.**
- **`fee.waive`, not `ledger.adjust`.** The first version gated waiving on `ledger.adjust` — wrong in a way worth recording, because the manager role's own description says it "cannot adjust the ledger", and R-004 created a separate `fee.waive` permission and granted it to managers precisely because forgiving a late fee is day-to-day work. Gating it on the wrong permission locked the people whose job this is out of doing it.
- **And a monetary ceiling, which R-004 built and nothing had ever called.** `waive_fee` is one of two `MonetaryAction`s and every role carries a `defaultWaiveFeeCents` (a manager's is $100). A permission says whether you may waive at all; the ceiling says how much — without it a manager could forgive a $2,000 fee that the same role could not approve as a work order. The refusal names both numbers, because "above your limit" leaves somebody guessing whether they are $5 or $500 over.
- **The waiver record stays on screen.** An operator deciding the next waiver should see the last one; that history is what fair housing turns on.
- **One action with a hidden `chargeId`, not a bound action per fee.** The first attempt handed a client component a `Record` of per-fee server actions and the identities did not survive the boundary — the control rendered with no accessible name and no handler, and `npm run build` did not catch it. No less safe: the id is untrusted either way and every check runs against the charge actually named.
- **The report screen distinguishes "needs two-factor" from "not permitted".** Discovered by the control refusing to render at all: `fee.waive` is a PRIVILEGED permission and R-004 requires verified MFA for it. That is the product working correctly — but rendering nothing to somebody who holds the permission and only needs to verify is a screen that looks broken, so it now says so.

**What it left behind.**
- The waive control lives on the lease page only. A portfolio-level "fees awaiting a decision" queue would be the natural home for bulk work and does not exist.
- The pattern report attributes a fee to the first tenant on the lease (a joint tenancy shares one ledger). Stated in R-040 and unchanged.

**Bugs found along the way** — three, all mine, all found by the e2e suite refusing to go green:
- **The wrong permission** (above), which rendered no control at all for the role that needs it most.
- **A `Record` of server actions across the Server→Client boundary**, which silently produced a button with no name.
- **The e2e fixture had no MFA enrolment**, so the control correctly refused to render. The product was right and the test was wrong — but chasing it is what surfaced the missing "verify to waive" message, which is a real improvement.

**Also in this commit.** `docs/UX-ACCESSIBILITY-LOG.md` — a full UX and accessibility review of every screen across all three audiences, with a verdict on every finding, the fixes to come, and an explicit list of what is already correct and must not be undone. Two systemic findings stand out: **there is no focus management anywhere in the product** (`grep -rn "\.focus()"` returns nothing), and `role="status"` is used eleven times in places where it announces nothing. Both are invisible to the axe gate by construction.

**Housekeeping.** Removed 103 `"… 2.ts"` duplicate files — iCloud conflict copies, because this repository lives under `~/Documents`, which is iCloud-synced. 57 were byte-identical and 2 were stale pre-edit snapshots of files changed today. None were tracked. Worth knowing: a sync service writing into a live git working tree can produce a conflict copy mid-write, and this is the second kind of environment hazard this project has hit after the shared `:3000` dev port.

## R-042 — Acting on the cloud review of the projection pipeline
**Commit:** `e15c88a`  ·  **Date:** 2026-08-11

**What it built.** Three fixes to the Stripe→ledger projection, two from an ultrareview of PR #2 and one found by writing the test for the first.

**1. A returned payment reversed only part of itself.** The linked-charge ledger rows did not carry `paymentId`, and `reverseSettledPayment` found the rows to undo *by* `paymentId` — so it reversed the remainder and left every linked charge credited. Now every row a payment wrote is reversed, each pointing at what it undoes and keeping its charge linkage, so a fee that was paid and then returned goes back to showing as outstanding rather than silently staying settled.

**2. A stale decline reversed money that had cleared.** `returnAction` read only the current status and discarded the event's own timestamp. One PaymentIntent can carry a decline followed by a successful retry, and Stripe promises neither ordering nor exactly-once delivery — so the decline arriving late would flip a settled payment to REVERSED and fire the locked-category "your payment came back" text at a tenant who had paid. A genuine return happens *after* settlement; the comparison is now made. The symmetric guard already existed in `writePayment` for a late `payment_pending`; this was the half that was missing.

**3. Payments never linked to charges at all** — found because the test for (1) failed at "expected 2 ledger rows, got 1". R-040c added the charge-id round trip to `invoice.finalized` and not to `invoice.payment_succeeded`, so a **paid late fee showed as outstanding on the tenant's pay screen for ever**: `outstandingCharges()` derives what is left from a charge's own ledger entries, and there were none. This also meant (1)'s described mechanism could not yet occur — with no linked payment rows there was only ever one row to reverse. The review was right about the defect and slightly ahead of the code.

**What it decided.**
- **Linked rows are only written if they fit inside what actually moved.** A partial payment reports only what arrived while the charges named on the invoice carry their full amounts; crediting each in full would forgive money nobody sent. When they do not fit, one unlinked row for the real amount — the balance stays right, and which charge it paid down is R-035's allocation policy rather than something to guess at in the projector.
- **The reversal amount comes from the original row, never the invoice.** A partial payment that returns must give back exactly what it gave.
- **A stale failure is ignored, not reversed.** Acknowledged so Stripe stops retrying, with the reason recorded.

**What it left behind.**
- The `fits` guard falls back to an unlinked row rather than allocating a partial payment across the charges it covers. That allocation exists in core (`allocatePayment`, R-035) and is not wired to the projector; doing so is a real piece of work and wants the review's opinion first.

**Bugs found along the way.**
- **A whole class of test flake, fixed at the root.** Several unrelated tests kept timing out at 5s under full-suite parallel load while passing alone — that is Vitest's *unit-test* default applied to a suite that is mostly integration against a remote Neon Postgres, where a 400ms test can take eight seconds under load. Raised to 20s globally, which also replaces a growing pile of per-test timeout arguments I had been adding one failure at a time. Two consecutive clean runs at 1,237 tests.

## R-098 — UX and accessibility remediation: the safety tier
**Commit:** `15e4417`  ·  **Date:** 2026-08-11

**What it built.** Two review passes over every screen and component in the product — one on UX, one on accessibility — produced ~40 findings, recorded in full with per-finding verdicts in `docs/UX-ACCESSIBILITY-LOG.md`. This item fixes the tier where a defect has a consequence outside the screen. The rest is R-099.

**The emergency maintenance flow, rebuilt.** It was one client component and nine `onClick` handlers, which meant the safety instructions — *turn off the gas, leave the building, call 911* — **did not exist in the page until React hydrated**. A tenant who could smell gas on a weak connection tapped a category and got nothing at all. That directly violates the rule this repo's own CLAUDE.md states. Now: the category list is server-rendered `<Link>`s, the chosen category lives in the URL, and the safety screen is a server-rendered page at its own address. Only the final details form is a client component, and it is a real `<form action>` + `useActionState`. An e2e spec walks the whole path with **JavaScript disabled** and asserts the instructions are on the page.

**The two questions no longer block the page-out.** `validateEmergencyRequest` required an explicit entry-permission and pet answer, and "Send now" was disabled until both were given — so at 2am with sewage rising, two questions stood between a tenant and paging somebody. Both are now optional, with **"I am not sure" offered as an explicit third answer** rather than something you reach by giving up, and nothing pre-selected. This reverses a rule an earlier item deliberately set, so it is written down in both the core test and the code.

**The vendor surface.** Four fixes, all on the one screen a plumber sees in a driveway:
- **Proposed times rendered in UTC** while messages twenty lines away used `utcToWallClock`. A vendor proposing 9am CT read back 14:00. Same defect class as R-036b's entry-window bug — I fixed the admin page then and missed this one.
- **The confirmed window was never passed to the component at all.** A vendor whose visit had been booked *and legally noticed to the tenant* still read "we'll confirm" and phoned the office to ask. Now the confirmed window outranks the proposal.
- **"Show code"** — the single action this surface exists to perform — destroyed focus, announced nothing, and gave every code the same accessible name. Now an `<output>` rendered empty from first paint (so the reveal is a mutation and therefore announces), `autoFocus` on the revealed code, and a per-code name.
- **Accept / propose / decline were a `useState` machine whose triggers unmounted themselves.** Native `<details>` instead: focus stays on the `<summary>`, and — the part that matters more — before hydration only *Accept* used to exist, so the two answers a landlord would rather not hear were the ones that needed JavaScript.
- A `tel:` link on the vendor rejection screen, from `OPERATIONS_PHONE`. Every vendor dead end said "call the office" and gave no number.

**What it decided.**
- **An unanswered safety question is recorded as unknown and never blocks a page-out.** `undefined` is still not `false` — whoever opens the door sees the difference between "no pet" and "we don't know" — but the paging is the part that cannot wait. This mirrors how R-030 records an unanswered verification rather than blocking on it.
- **The safety screen is a URL, not a state.** That makes it deep-linkable, survivable without JavaScript, and removes the focus and announcement problem rather than solving it: a real navigation needs neither.
- **`<details>` over a state machine** wherever a disclosure gates a form. It retains focus and works with no JavaScript, and the admin side already uses it.
- **"Show code" stays an `onClick`.** Flagged as a hydration dependency; declined. Revealing an access code is a privileged read that writes an audit row, and it *should* require a live session rather than working from a cached page.
- The report is split R-098 (safety) / R-099 (the rest) rather than worked as one item, and the split is by consequence, not by severity label.

**What it left behind.**
- **R-099 owns everything else**, including the two systemic findings: there is no focus management anywhere in the product (`.focus()` appears zero times, and it is the root of seven separate findings), and eleven `role="status"` regions that announce nothing because the region is inserted alongside its own content.
- **The gate cannot catch any of this.** Nothing asserts where focus lands after a server action, and axe's `scrollable-region-focusable` only fires when a table actually overflows at the test viewport. A shared e2e focus assertion is part of R-099 and would have caught most of the High tier.
- `OPERATIONS_PHONE` is unset in `.env.example` by design (names only). Unset renders no number rather than a dead "call us" — honest, but not good. Set it before any vendor sees the screen.

**Bugs found along the way.**
- **The item numbering had started to collide.** This work was being stamped `R-043` in code comments while backlog R-043 is *tenant-visible ledger + portal payment* — an unbuilt item that will touch some of the same files. Renumbered to R-098/R-099 before it set. The backlog already carries a dozen duplicate ids from earlier sessions; those are not worth rewriting, but a fresh one was.
- Two vitest files failed once under full-suite parallel load and passed on an immediate clean re-run. Noted rather than chased; the 20s global timeout from R-042 already addressed the known cause.

## R-099 — The missing route boundaries, and the gate gap that hid them
**Commit:** `a60aeda`  ·  **Date:** 2026-08-12

**What it built.** The second tier of the UX and accessibility report (`docs/UX-ACCESSIBILITY-LOG.md`). Two things: the screens people land on when something goes wrong, and the assertion whose absence let the whole R-098 tier ship in the first place.

**There was no `error.tsx`, `not-found.tsx` or `loading.tsx` anywhere in the product** — zero files — while **fourteen pages call `notFound()`**. So a tenant following a stale link out of a six-month-old text message got Next's bare 404: black on white, no navigation, no way back, no hint that their account was fine. An unhandled throw showed *"Application error: a client-side exception has occurred"* — a sentence written for a developer — to whoever was standing there.

Seven files, one set per audience, because the three audiences need genuinely different things:

- **Tenant** — the portal's own chrome (so it is a bad moment, not a dead end), the phone number, and the 911 line, because emergencies do not wait for a working web page. D-10's premise is that the portal is a convenience and never the only way to reach a landlord; the screen that just failed is where that has to be most true.
- **Staff** — the error digest, said out loud. It is the only handle on the server-side stack trace, Next redacts the message and leaves the digest precisely so it can be quoted, and an operator who can read it to somebody has turned "it broke" into a searchable log line.
- **Vendor** — retry and a `tel:` link, and nothing else. The magic link *is* the whole surface (D-6): no account, no navigation, no history to fall back on.

**The gate gap is closed.** `expectFocusSurvived(page, context)` asserts that a completed interaction did not drop focus to `<body>`. Both accessibility reviews independently identified the same root cause — `.focus()` appeared **zero** times in `apps/web` — and both noted the same reason it survived every gate we have: axe scans a static snapshot and cannot see where focus *went*, so a page could fail this on every interaction and still pass the accessibility spec.

**It was verified by making it fail.** A `blur()` inserted before the call produced the expected red with the intended message, and was then removed. A green assertion nobody has watched go red is not evidence of anything — the same reasoning D-27 applies to simulated adapters, turned on a test.

**Three findings that were mine, from the two items before this one.**
- **H5** (`offline-payment-form.tsx`, R-038): the channel radios are `sr-only` with the label standing in for them visually, and the label carried **no focus styling of any kind** — so a keyboard user tabbing into the group got no indication whatever of where they were. The control looked identical focused and unfocused.
- **M8** (same file): two field errors rendered as bare `<p>` with no `id`, no `aria-describedby` and no `role="alert"`. `TextField` had solved exactly this since R-008 and I did not use it. Now it does.
- **M7** (`fees-panel.tsx`, R-041): every fee on a lease rendered a trigger reading the identical string *"Waive this fee"*, so a screen-reader user listing the page's controls heard it N times with nothing to tell them apart. The trigger also unmounted itself on activation, and the reason error had no `role="alert"`.

**What it decided.**
- **`<details>` is this codebase's disclosure**, now in three places (admin panels, the vendor answers in R-098, the waive form here). A `<summary>` survives its own activation, so focus is retained by construction rather than restored by hand — and it works before hydration, which a `useState` toggle never does.
- **`NEXT_PUBLIC_OPERATIONS_PHONE`, one variable, read from both sides.** `error.tsx` is a client component that takes no props, so it cannot be handed a server-read value. A second variable holding the same number is the kind of thing that gets set in one place and not the other; a phone number printed on a screen we hand to strangers has nothing to protect by being server-only.
- **The staff 404 names both possibilities and picks neither.** Most staff `notFound()` calls are ROLE-01 scope refusals, which answer 404 rather than 403 on purpose — "forbidden" confirms the record exists. A well-meaning edit to "this record does not exist" would turn the screen into an oracle for whether an id is real, so the wording is asserted in the spec with that reason written next to it.
- **`loading.tsx` gets no skeleton.** A skeleton that does not match what arrives is a small lie told on every slow load, and these pages differ too much for one shape to fit.
- **`role="status"` is correct in `loading.tsx`** — and the comment says why, because it is wrong in eleven other places: the region genuinely arrives after the page it replaces, so the mount *is* the event.

**The bug this item found in itself.** `loading.tsx` shipped for all three audiences and took **eight scoping specs across seven files** red — every one of them `expect(response.status()).toBe(404)` receiving **200**.

A `loading.tsx` wraps its segment in a Suspense boundary, so the response starts streaming with a 200 header before the page body runs, and a status already on the wire cannot be retracted. The not-found page still renders correctly, so in a browser nothing looks wrong at all; only the status line is. And it matters precisely here, because **ROLE-01 answers 404 rather than 403 for a record outside your scope on purpose** — "forbidden" confirms the record exists. Those eight assertions are what keep that true, and a loading spinner two directories above them turned all of them into 200s.

`loading.tsx` was dropped. A correct status on a scope refusal outranks a spinner, and if loading states are wanted later they belong on leaf segments that never call `notFound()`. Recorded in CLAUDE.md's runtime traps: it fails at neither build, typecheck nor vitest.

**How it was found, which is the more useful half.** It was not found by the gate — it was found by *reading the gate properly for the first time*. Every e2e result reported this session came through `npm run test:e2e 2>&1 | tail -12`, which shows the failure list and cuts off the `N failed` line above it. Two runs earlier in the session were reported as green on that basis. The `N passed` figure also never reconciled against the suite size (582), and three different totals — 342, 566, 574 — went unquestioned. CLAUDE.md now says the gate is `passed + skipped + flaky` reconciled against `playwright test --list`, never `0 failed` read off a tail.

**What it left behind.**
- **R-101 owns the remainder**: the maintenance wizard, the eleven inert live regions, the timezone display sites, the medium/low UX batch — and rolling `expectFocusSurvived()` across the rest of the suite, which will turn up real failures. That is the point of it, and the reason it is not a one-line change.
- **Focus after a *successful* waive is still lost.** `<details>` fixes the open; when the server confirms, the form is replaced by the waived record and focus falls to `<body>`. That is the general S1 pattern (M4) and belongs with the rest of it rather than as a one-off here.
- The report split R-098 / R-099 / R-101 by consequence and by what a single session can actually verify, not by severity label.

## R-102 — The global-sweep tests, and a backlog nothing would have reported
**Commit:** `99d3908`  ·  **Date:** 2026-08-12

**What it built.** Two small things and one correction.

**The correction comes first, because the item was filed on a wrong premise.** R-102 was written as *"the sweeps take no batch limit, and a Vercel cron has a duration cap"* — a tidy story that fit the evidence. Reading the code disproved it: `dispatchPendingNotifications` has taken `limit = 100` since R-016, and `unacknowledgedEmergencies` is bounded to 100 rows inside a 24-hour window with a comment explaining both. The backlog row now says what is actually wrong. The diagnosis was asserted from a stack trace and a row count without opening either function.

**The real cause is test debris, and it is a direct consequence of obeying our own rule.** CLAUDE.md requires every spec to dispatch only its own rows via `only:`. That is right, and it means everything else stays QUEUED for ever — nothing in the test environment plays the part the hourly cron plays in production. The shared database reached **27,392 delivery rows**.

That stays invisible until a test sweeps globally, and one does, deliberately — it is the only proof the cron's own path works. It has to pass a large batch to guarantee its own rows are reached, because the sweep orders by id and a fresh cuid sorts last. So it sends the entire accumulated backlog, two round trips per row, sequentially, and it outgrew its 60s timeout. `sweepEmergencyEscalations` pays the same way: in production somebody acknowledges an emergency within minutes, in the suite nobody ever does, so every emergency any spec or e2e run ever created is still open and still due.

Both specs now retire rows **older than an hour** in `beforeAll` — old enough that no concurrently-running fixture can be touched, since every fixture in this suite is created inside its own test. Self-healing: the cost no longer grows with the age of the database.

**`DispatchResult` gained `remaining`**, and the cron response reports it. The sweep takes at most `limit` rows and recorded only `sent` and `failed` — which look identical whether the queue is empty or ten thousand deep. An engine whose premise is that a delivery record must never be silently false should not be able to hide a backlog either.

**What it decided.**
- **`remaining` reports; it does not act.** The drain is still one batch per tick. A loop that keeps going until the queue is empty is the right answer only once this number is persistently non-zero on a real portfolio, and building it first is guessing at a shape the backlog has not shown. This is the instrument that says when.
- **An hour is the debris threshold**, not a marker column or a dedicated schema. The oldest fixture any spec builds is twenty minutes back, so an hour cannot reach a live one, and it needs no coordination between files. Per-file schemas remain the genuinely correct answer to this whole family (R-037c said so and still stands); this is not it, and is not pretending to be.
- **`NotificationDelivery` and `Ticket` are ordinary tables** — the append-only set is `LedgerEntry`, `AuditLog`, `Message`, `Notification`. The retirement touches the delivery row and the ticket's `acknowledgedAt`, never the notification itself.

**What it left behind.**
- **The drain rate is still 100 an hour** for notifications. Fine for a 10–50 unit portfolio until R-045 starts sending payment-lifecycle notices to everybody on the same morning; `notificationsRemaining` on the cron response is what will say so.
- **The debris keeps accumulating** — this retires it rather than stopping it. Every spec still leaves its unsent rows behind. Per-file schemas end that; nothing else does.

**Bugs found along the way.** None new. This item exists because of one I had dismissed three times as "flake under parallel load" — twice in writing, in R-098's PROGRESS entry. It was reproducible, diagnosable, and had a growing row count behind it the whole time.

## R-100 — Durable object storage (with R-102b)
**Commit:** `c5d70ab`  ·  **Date:** 2026-08-12

**What it built.** D-14's swap, taken on the day its stated trigger arrived. `lib/storage/index.ts` now wires `VercelBlobStorageAdapter` when a Blob token is present and `LocalDiskStorageAdapter` when it is not.

**What was actually broken.** Deploying to Vercel means a fresh, per-invocation filesystem. Every uploaded lease, vendor invoice and maintenance photo written by the local-disk adapter was gone by the next request — while the `Document` row claiming it exists survived. The evidence trail is the product; an evidence trail that loses its photos is not one. D-14 named this exact trigger in advance — *"whenever this deploys somewhere the filesystem isn't durable across instances"* — and left the seam for it, so this was one assignment plus an adapter, as promised.

**Two decisions, recorded as D-37 because a later session must not quietly reverse either.**

**Private, not public.** Vercel Blob's better-known mode is `access: 'public'`, which mints a permanent unauthenticated URL guarded only by an unguessable suffix — a capability URL. This product stores signed leases, identity documents and photographs of the inside of somebody's home. One leaked URL — a support ticket, a browser history, a screenshot — is public for ever, with no revocation and nothing in the audit log to say it was read. `access: 'private'` keeps every read authenticated against the store's own token, so the two routes that serve files carry on doing exactly what they did: authorise the caller, then stream the bytes. **Nothing about who may see a document changed**, which is the property a storage swap has to have.

**Selected by token presence, never by `NODE_ENV`.** The tempting version is `NODE_ENV === 'production'`, and it is wrong in both directions: a production build on a laptop would reach the real store, and — the failure this item exists to end — a deployed environment whose Blob store was detached would silently resume writing to a vanishing filesystem and look entirely healthy until somebody opened a photo months later. The environment is asked what it actually has. A test asserts the `NODE_ENV` version stays out.

**`storageDurable` is reported on the cron response**, so a silent reversion is visible rather than inferred.

**Verified against the real service, not just the types.** A smoke run put, read back and deleted an object in the production store: pathname preserved (`addRandomSuffix: false`), bytes identical, content type intact, delete confirmed. The same discipline R-040d applied to the Stripe driver, and for the same reason — unit tests cannot prove an SDK behaves the way its type definitions claim.

**What it decided.**
- **Local disk stays dev and test**, unchanged from D-14. The suite must not depend on a network round trip or on anybody's Blob quota to assert that an upload worked.
- **`allowOverwrite: true`.** The key is unique by construction, so an overwrite means a retry of the same upload rather than a collision; refusing it would turn a duplicate submit into a 500 on a tenant's photo.
- **A missing object throws**, matching the local adapter's ENOENT. Both callers already treat a throw as "the file is gone", so the seam keeps one behaviour rather than two.

**What it left behind.**
- **Nothing needed migrating, by luck of timing rather than design.** The production database was empty when this landed, so no `Document` row points at bytes on a vanished filesystem. A week later this would have needed a backfill and there would have been nothing to back-fill *from*.
- The documents written during development stay on the dev machine's disk, which is where the dev environment still reads them.

**Bugs found along the way.**
- **Creating the Blob store put the token into `.env.local` without anyone choosing it.** The Vercel CLI writes it there on `create-store`, and the storage seam selects durable storage on its presence alone — so the next `npm test` would have written real objects into the production Blob store, on the account's quota, from whichever laptop last ran `vercel env pull`. Caught in the CLI's own output. `BLOB_READ_WRITE_TOKEN: ''` is now pinned in **both** `vitest.config.ts` and `playwright.config.ts`, beside the identical guard `STRIPE_SECRET_KEY` already needed for exactly the same reason.

**R-102b, landed in the same commit — finishing what R-102 only half-fixed.** R-102 solved the notifications sweep properly and applied a weaker remedy to the escalation one without checking that it held. The very next full run proved it had not.

`sweepEmergencyEscalations` gained the `only: { ticketIds }` filter that `dispatchPendingNotifications` and `dispatchOutbox` have carried since R-016 — the convention CLAUDE.md already mandates, and which this sweep had simply never been given. The originally-failing test went from a 30s timeout to **0.8s**.

A different test then failed, so the rest was **measured rather than guessed at a second time**. Four of these tests genuinely take **25–28 seconds each in isolation**, filtered, against a pooled Neon connection: a page is a rota lookup, then per recipient per channel a preference read, an idempotency check, two inserts and an audit row, then two more round trips to claim and send each delivery. The budget was 30s.

That is not flake. It is a deadline set below the measured cost, and a 28s test with two seconds of headroom tips over the moment anything runs beside it. Raised to 90s with the measurement written next to it — the same reasoning R-042 used raising the global default from Vitest's 5s unit-test default for a suite that is integration against a remote database.


## R-040e — `STOP` is handled, and the delivery record stops being able to lie
**Commit:** `cca6a40`  ·  **Date:** 2026-08-13

**What it built.** Six pieces, closing a defect whose visible half was cosmetic and whose invisible half was the worst kind this product can have.

**The visible half:** a tenant texting `STOP` opened a maintenance ticket titled *STOP*.

**The half that mattered:** `entry_notice` is in `LOCKED_CATEGORIES` *because it is legally significant* — the product refuses to let a tenant switch it off. A carrier-level STOP switches it off anyway, and our notification log went on recording those notices as `SENT`. In a Texas entry dispute that log is the evidence. **A delivery record that can be silently false is the worst defect an evidence trail can have**, in a build whose stated premise is that the evidence trail *is* the product.

**1. `classifyOptOutKeyword`, and the reason it is a whole-message match.** The CTIA keyword set, matched against the entire trimmed message or not at all. The asymmetry is the design: treating a real STOP as ordinary text is embarrassing, while treating *"please stop the leak under the sink"* as a STOP silently unsubscribes somebody from the one category they are not allowed to leave — and our record would look normal afterwards. Tested with the sentences a tenant actually sends.

**2. `SmsOptOut`, keyed by phone number rather than tenant.** A carrier block is a fact about a *number*: it survives the tenant moving out, it applies to whoever holds the number next, and nothing in `NotificationPreference` can override it. Preferences are a tenant's choice about a category; this is a carrier's fact about a number, so it is a separate table and it outranks `LOCKED_CATEGORIES`.

**3. Intake interception**, before routing. The message is still recorded — the tenant sent it, and an evidence trail that drops the one message which changed what we may send them is not an evidence trail. It just does not open a ticket.

**4. Suppression at decision time**, `SUPPRESSED / sms_opt_out`, checked *before* the preference check. Recording it as `preference_off` would describe a choice the product does not offer and would hide that we owe the tenant a notice we could not deliver.

**5. D-38's Task.** The owner chose "both". Reading the code first showed the fallback half was **already true** — `entry.notice` has declared `SMS`, `EMAIL` and `PORTAL` since R-021 — so building a fallback mechanism would have been redundant machinery invented from the decision's text. What was missing is the human: `serve_notice_offline`, `URGENT`, idempotent on the notification's own key. Raised only for locked categories, because a blocked marketing text is a tenant getting exactly what they asked for.

**6. The status callback.** `SENT` has meant *the provider accepted it*. `mapDeliveryStatus` and `shouldApplyStatus` turn that into `DELIVERED`/`FAILED`, and the route records the provider's error code. Twilio's `21610` — "they replied STOP" — records the opt-out, which is how we learn about the blocks the carrier absorbed and never forwarded: **the common case, not the edge one.** `30003`/`21211` are failures and deliberately *not* opt-outs, because unsubscribing somebody whose phone was merely off would be the same false-record defect wearing a different hat.

**What it decided.**
- **Statuses only ever move forwards.** Callbacks are retried and unordered; a late `sent` landing after a `delivered` must not walk the record backwards, and `FAILED` is terminal because a human may already have acted on it. The same out-of-order hazard R-042 fixed in the Stripe projection, met again in a different provider.
- **A callback never overwrites `SUPPRESSED` or `DEFERRED`** — those describe decisions made before sending, and a callback is about a message that row is not describing.
- **An opt-out is recorded even when the delivery row cannot be matched.** The block is a fact about the number and outranks our bookkeeping; dropping it because of a join failure would reintroduce the exact defect.
- The route is written and tested with signed payloads although **nothing posts to it yet** (D-15 still wires the logging adapter). The alternative is discovering the mapping is wrong on the day real messages start moving — and `CARRIER_CALLBACK` would otherwise be an enum value nothing could produce.

**What it left behind.**
- **No end-to-end proof.** Every part is tested, but no real Twilio message has traversed it; that waits on the campaign clearing. The signature check, the mapping and the ordering rules are the parts that could be got wrong on paper, and those are covered.
- **HELP gets no reply from us.** The carrier answers it; `optOutReply` returns the text but nothing sends it, because sending requires the adapter D-15 defers.
- **Staff cannot see or clear an opt-out in the app.** It is visible in the audit log and the task. A screen belongs with R-049's messaging work.

**Bugs found along the way.**
- **`Task.priority` is the `Priority` enum, and this is the second item to get it wrong** — `HIGH` does not exist here. It failed at runtime rather than compile time because `TaskInput.priority` was typed `string` and the persistence layer cast it away with `as never`. Fixed at the root: the field is now `TaskPriorityValue`, the cast is gone, and the compiler found four other call sites that had widened the enum back to `string` in their own helper signatures. The one genuine string boundary — a priority arriving from a form — casts explicitly, with `validateTask` still doing the checking.
- **Imported `@/lib/audit/index.ts` in a webhook path**, which pulls in Auth.js and breaks the test loader. `sms-intake.ts` carries a comment warning about exactly this; the fix is `audit/system.ts`. Caught by the suite refusing to load `next/server`.

## R-039a (part) — The returned-payment fee, end to end
**Commit:** `b65161c`  ·  **Date:** 2026-08-13

**What it built.** The NSF fee push. `nsfFeeFor` was written in R-039, unit-tested in core, and **callable by nothing** — there was not even a column to hold what the lease provides for. So the tenant's returned-payment notice carried a comment explaining that it stays silent about a fee "rather than quoting a fee that does not exist". That comment is now gone, because the fee exists.

**Two columns, each with a reason.**

`Lease.nsfFeeCents` is **nullable, and null means no fee** — not zero, and deliberately not a default. `nsfFeeFor`'s own comment says why: the fee is a contractual term first and a statutory ceiling second, and inventing one the tenant never agreed to is how a fee becomes unenforceable at exactly the moment somebody needs to enforce it. Defaulting a value in would have charged every tenant on every lease signed before the column existed.

`Charge.assessedOnPaymentId` is the counterpart of `assessedOnChargeId`: a late fee answers to a rent charge, a returned-payment fee answers to a Payment. It carries a **partial unique index**, so one NSF fee per returned payment is enforced by the database rather than by a read-then-write check that two concurrent webhook deliveries would both pass. There is a test that bypasses the code path entirely and asserts the database refuses the second row.

**Raised inline, before the notice, and the ordering is the design.** The architecturally tidier option is an outbox event with a consumer — how ticket triage and make-ready work — but consumers run on the hourly cron, so the fee would land up to an hour after the notice that should have quoted it. The tenant would get "your payment came back" now and "you have been charged $25" later: two shocks where one honest sentence would do.

**The fee reaches SMS, not just email.** The template already had a `feeAmount` slot and used it only in the email body. `payment_failed` is a LOCKED SMS category — the one a tenant cannot switch off and therefore the one they actually read — and learning about a charge from a later invoice, having been texted about the same event, is how a tenant decides the landlord is hiding things.

**What it decided.**
- **Only a fee that was actually raised is quoted.** `assessNsfFee` returns a null `chargeId` for every legitimate no-fee case — the lease is silent, the state forbids it, no rule is configured — and in all of them the message stays silent. The rule that kept `feeAmount: null` for two items still stands; it just no longer applies to every case.
- **The fee is not in `balance`.** It is pushed to Stripe as an invoice item and reaches the ledger only when the next invoice finalizes (D-11), so at the moment the notice is written the tenant owes `balance` and will owe the fee on top. The message says both, separately, because that is what is true.
- **No configured rule means no fee**, exactly as late fees treat it. D-4's point is that a statutory number comes from configuration; inventing one for an unconfigured state is how a product charges an unlawful fee in a market nobody has set up yet.
- **A failed push leaves the Charge standing** with a null `stripeInvoiceItemId` — recoverable and visible — rather than leaving an invoice item in Stripe naming a charge that does not exist. Same trade `assessLateFees` made.

**What it left behind.**
- **R-039a is not finished.** This is the correctness half. Still outstanding: the tenant-facing saved-payment-method flow (`createSetupIntent` has existed since R-034 and still nothing calls it, so autopay cannot actually be switched on by a tenant), the tenant-chosen debit day, the owner's "require full balance" switch, and the T-2 pre-debit notice. The payment-method UI is Stripe Elements against a live key and cannot be meaningfully tested without one (D-15), which is why it is still not guessed at.
- **Nothing sets `nsfFeeCents`.** The column exists and the fee works when it is populated; no lease form writes it yet. That belongs with the lease-terms editing work, and until then every lease is silent — which is the safe direction to be wrong in.

**Bugs found along the way.**
- **A migration edited after it had been applied.** The Charge columns were appended to `20260813090000_lease_nsf_fee`, which had already run. Prisma records an applied migration by checksum, so `migrate deploy` reported nothing pending while the new SQL never executed — the column existed in `schema.prisma` and not in the database. Split into its own migration, with the reason written into its header.
- **A test that asserted nothing and reported as covered.** The clamp test read the shipped Texas rule, found `nsfFeeMaxCents` null, and returned early — 133ms, green, vacuous. It now creates its own capped rule in its own state and asserts both numbers appear in the charge description. **A test that silently does nothing is worse than no test**, because it reports as coverage.

**Follow-up, same day — the field, and the drift CI caught.**

**`nsfFeeCents` is now settable.** The fee above was unreachable: the column existed and nothing wrote it, so every lease was silent. Wired through `validateLease`, both lease actions and the form. **Blank stays null**, and the e2e spec asserts it — null means the lease says nothing about returned payments, which means no fee, whereas `0` would mean a lease that expressly charges nothing. Those are different sentences and nobody wrote the second one. A `?? 0` creeping into the action (as it legitimately does for the deposit, two lines above) would start charging a fee on every lease signed before the field existed.

**CI found schema drift the moment billing was unblocked, and it was mine.** `SmsOptOut` declared `@@index([phone])` while the migration created a **partial** index — `WHERE "revokedAt" IS NULL`. Prisma cannot express a partial index, so `prisma migrate diff --exit-code` saw a declared index the database did not have and reported drift on every run, permanently. CLAUDE.md warns about this in as many words: *"triggers, partial indexes and backfills do not survive a generated diff."*

Dropped rather than annotated, because it bought nothing either way: `phone` is already `@unique`, there is exactly one row per number, and `WHERE revokedAt IS NULL` was filtering a single already-located row. Speculative optimisation that cost a permanently red check.

**The wider lesson, now in CLAUDE.md.** I ran the four-part gate before every commit this session and never once looked at CI. It does two things the local gate structurally cannot: it applies every migration to a **throwaway Postgres from scratch**, and it runs the drift check. Locally, migrations are only ever applied incrementally to a branch that already has data — so a migration that is out of order, that fails on an empty database, or that creates something Prisma cannot model is invisible here. Three hand-written migrations landed today; one of them had already needed splitting after being edited post-application. The drift command is now written into CLAUDE.md to be run before pushing a schema change.


## R-041 — Deposits as liabilities
**Commit:** `fec1143`  ·  **Date:** 2026-08-13

**What it built.** The one idea the whole item exists to enforce: **a security deposit is not income.** It is the tenant's money, held on trust, owed back minus whatever can lawfully be proved at move-out. A product that folds it into revenue reports a number the owner has not earned and — worse — invites spending money that has to be returned. Several states wrote escrow laws for exactly that reason.

**What was there before.** `Lease.depositCents` was a bare integer stating an intention. `ChargeType.DEPOSIT` existed in the enum and nothing created one. Nothing recorded whether a deposit was ever actually collected, nothing distinguished it from rent, and nothing checked it against a statutory ceiling.

**`DepositArrangement`, because the amount cannot say how it is held.** Three cases that behave completely differently at move-out:
- **CASH** — a liability, returnable, and in several states escrowed and interest-bearing.
- **SURETY_BOND** — the tenant paid a premium to a third party and this landlord holds **nothing**. Nothing to escrow, no interest, nothing to return.
- **NONE** — no deposit at all.

Recording a surety bond as "a cash deposit of $0" would be true and useless. The failure it prevents runs in both directions: a tenant chased to collect a refund nobody owes them, or an owner believing they hold money that was never taken. A **database CHECK** enforces that anything other than CASH holds zero, because the same contradiction reached by an import or a fixture causes the same confusion as one typed into the form.

**The statutory cap is checked when somebody types the amount, not at move-out.** Over-collecting is a violation on the day it is taken and in several states the remedy runs to multiples of the excess, so discovering it two years later — when the tenant's lawyer does — is the expensive way round. `depositCapCents` reads `depositMaxBps` from the versioned rule (D-4) and **rounds down, because a cap rounded up is a cap exceeded**.

**Null is not zero, and the distinction is load-bearing.** A state with no configured ceiling yields `null`, which means "no statutory cap" — Texas, for one. Reading that as `0` would block every lease in Texas; reading `0` as `null` would permit an unlawful deposit wherever a state genuinely bans one. There is a test for each direction.

**What it decided.**
- **The held amount is modelled as a liability now, before there is any income reporting to keep it out of.** There is no revenue total or CSV export in the product yet, so "separate from income everywhere" currently has nothing to be separate *from*. `depositHeldCents` exists anyway, so R-050's dashboard and any future export get a function that already answers "how much of this is not ours" rather than a column they must remember about.
- **Held is what was received, never `Lease.depositCents`.** That column is what the lease says *should* be collected — an intention. The two differ for every lease where the tenant paid late, partially, or moved out.
- **`RETURNED` and `APPLIED` are distinct movements** even though both reduce the liability, because only one of them becomes income. R-071 owns the disposition that decides which.
- **Obligations are returned as a list, not two booleans**, so a screen can render them without knowing which rules exist and a state that adds a third does not need every caller edited.
- **Defaulted to CASH** on the existing table: the column did not exist, so nobody could have chosen otherwise, and every lease carrying a non-zero deposit today is a cash deposit by construction.

**What it left behind.**
- **No deposit movements are recorded yet.** `depositHeldCents` takes movements and nothing produces them, because a deposit is collected through Stripe like any other charge and the projection does not yet distinguish a `DEPOSIT` charge from rent. That wiring belongs with R-035's allocation work; until it lands, the held figure is derivable only from the lease's stated amount.
- **Escrow and interest are surfaced, not enforced.** The lease page names what the state demands of money being held. Nothing checks that a separate account exists or that interest was paid — neither is knowable from inside this product.
- **R-071 still owns move-out disposition**, which is where `APPLIED` gets its first real caller.

## R-042 (part) — Prorations: our arithmetic, not Stripe's
**Commit:** `e92d920`  ·  **Date:** 2026-08-13

**What it built.** The move-in proration, computed in core and pushed to Stripe as an invoice item. R-036 provisioned the subscription, recorded `firstPeriodPartial`, and stopped — leaving a comment that R-042 owned the amount "so a later item cannot silently skip it". That comment is why this was findable, and it is now discharged.

**Why the arithmetic is ours (D-12).** Stripe can prorate, and its proration is built for mid-cycle **plan changes**: it divides by the seconds in a billing period and answers *how much of this subscription did they consume*. A move-in on a calendar rent asks a different question — *how many days of this month did they live here* — and a lease answers it with a daily rate the tenant can check against their own calendar. The two agree by coincidence and disagree whenever a month is not 30 days, which is nine months in twelve.

**`prorationMethod` is per lease**, because leases genuinely disagree — `prorateRent` has said so in a comment since R-035. A 9-day February move-in on $1,500 rent is **$482.14** on actual days and **$450.00** on a flat 30-day month. Which applies is a term of the contract, so it lives on the contract. Defaulted to `ACTUAL`, because dividing by the days a month really has is what a tenant checking a calendar expects, and the 30-day convention is the one that should have to be chosen.

**The charge carries its own arithmetic.** PAY-08 requires the method to be visible on the tenant's ledger, so the description reads *"Part month — $1,500.00 × 12/31 days = $580.65"*. A tenant can verify that; "Proration $580.65" has to be taken on trust, and how the number was reached is the first question in every move-in dispute.

**What it decided.**
- **The divisor is the move-in month's own length**, never the length of the period covered nor the following month's. A tenant moving in on 20 February for a 1 March anchor owes 9/28 — not 9/9, which would charge a whole month, and not 9/31, which would undercharge. There is a test for each wrong divisor.
- **The range is half-open.** The anchor day belongs to the full month that follows and is separately charged; counting it in both is the classic proration bug.
- **Null, not zero, when there is nothing to prorate.** A lease starting on the due day owes a whole month, and a zero-amount line on a tenant's very first invoice is noise somebody has to explain.
- **Null rather than truncating when the first period exceeds a month.** That is not a proration; it is a lease whose first period is longer than a month, and this function has no opinion about that.
- **Typed `RENT`, not a bespoke charge type.** It *is* rent, for fewer days. A separate type would drop it out of every rent-versus-fees split the product already makes.
- **The boundary comes from `billingCycleAnchor`** — the same function that told Stripe when to bill — so the two cannot disagree about where the part month ends.

**Bugs found along the way.**
- **An extra day of rent on every move-in west of UTC.** `Lease.startsOn` is `@db.Date`, which Prisma returns as UTC midnight; I read it with `businessDate(value, propertyZone)`, which converts an instant into a local calendar day and therefore moved it to the *previous* day for every property west of UTC. A 12-day March proration billed as 13. **All ten core unit tests passed while this was true**, because the defect was entirely in how the date was read out of the database — the arithmetic it was fed was correct, just for the wrong dates. CLAUDE.md already warned that `@db.Date` comes back as UTC midnight; it now also says that converting one *through* a zone is the same bug wearing a different hat, and names the two readers: `utcToBusinessDate` for a calendar day, `businessDate(instant, zone)` for a real timestamp.

**What it left behind.**
- **R-042 is not finished.** This is the proration half. Still outstanding: **pet rent and flat utility fees as additional subscription items**, and **RUBS-style allocation with the underlying bill attached and the math documented per bill** (config-gated where a jurisdiction restricts it). `allocate()` already exists in core, tested, and distributes remainder cents to the largest fractional shares so the parts sum exactly — it has no caller yet.
- **Move-out proration is not built.** `moveInProration` is named for what it does. A move-out mid-month is the mirror image and belongs with R-071's disposition work, where the final balance is settled.

## R-039a (part 2) — Autopay enrolment, the server half
**Commit:** `bdebcf4`  ·  **Date:** 2026-08-13

**What it built.** The path from "the tenant saved a card" to "autopay actually works". `createSetupIntent` has existed since R-034 with no caller; this is the other end of it — what happens when Stripe confirms one.

**Saving a card is not enrolling in autopay, and that gap is the whole item.** Stripe ends up holding a payment method, but the subscription still bills however it was created — and every payer provisioned before this existed sits on `charge_automatically` with no method attached, which finalizes an invoice and then fails it. A tenant who did everything asked of them would watch their rent go unpaid. So enrolment does both halves: makes the method the default, and moves the payer onto automatic collection.

**Set on the customer AND the subscription.** Stripe falls back to the customer default when a subscription names none, but "falls back" is not a guarantee to build autopay on — a subscription created before the method existed keeps whatever it was born with.

**It arrives as a webhook, not a browser callback.** The browser can be closed the instant after the tenant taps confirm. A tenant who completed the flow must not end up without autopay because their phone slept.

**A third interpretation outcome, because it moves no money.** `interpretStripeEvent` returned project-or-ignore; a setup intent is neither. Forcing it through the projection path would demand an amount, and the only honest amount is zero — a zero-cent ledger entry that looks authoritative and says nothing. It is now `autopay_enrolled`, handled before the projection path, with a test asserting the ledger is untouched. **The compiler found every place that needed updating** the moment the union gained a member.

**What it decided.**
- **`defaultPaymentMethodId` records what we told Stripe, not a second source of truth** (D-11) — the same relationship `stripeAmountCents` has. It lets a screen say "a card is on file" without a network call per lease.
- **Never a card number, a last-four or an expiry.** A Stripe payment-method id and nothing else. §6.6 keeps those details inside Stripe-hosted fields, and storing a last-four starts down a road this product has no reason to be on.
- **Enrolment never throws.** A 500 makes Stripe retry, which is right for a transient database failure and wrong for a customer we do not recognise — a permanent condition no number of attempts fixes.
- **A setup intent naming no payment method is refused with a reason**, not acknowledged as a success that changed nothing.

**What it left behind.**
- **The tenant-facing Stripe Elements screen is still not built**, so a tenant still cannot start enrolment — only complete one. That is the last piece of PAY-02's Must story, and it is the piece D-15 says cannot be meaningfully e2e tested (Elements is a cross-origin iframe). It will need hand-verification against the test key, and PROGRESS should say so plainly when it lands rather than implying coverage.
- Tenant-chosen debit day, the owner's require-full-balance switch, and the T-2 pre-debit notice are all still outstanding.
- **The webhook subscription had to be widened by hand** to include `setup_intent.succeeded`. Adding a type to `HANDLED_EVENTS` does not subscribe to it; a handler nothing is subscribed to is dead code that looks live. Recorded in DEPLOYMENT.md.

## R-039a (part 3) — The autopay enrolment screen
**Commit:** `09b6f1c`  ·  **Date:** 2026-08-14

**What it built.** The screen a tenant actually touches. `createSetupIntent` has existed since R-034 and part 2 built what happens when Stripe confirms one; this is the half that lets a tenant *start* enrolment rather than only complete one. PAY-02's Must story is now reachable end to end.

**NOT COVERED BY THE E2E SUITE, and this is stated plainly rather than left to be inferred.** Stripe Elements is a cross-origin iframe that Playwright cannot drive without brittle same-origin assumptions — D-15 said so before the item was scheduled, which is why it was never guessed at earlier. What *is* tested: the server action's scoping, the `setup_intent.succeeded` webhook, the collection-method switch, and the three-way `autopayOn` state. What is not: the browser confirming a card with Stripe. **That needs hand-verification against the test key, and this entry is where that gap is recorded.**

**`autopayOn` requires both halves.** A saved card on a `send_invoice` payer collects nothing, and an automatic payer with no method on file is an invoice that finalizes and then fails — the state every payer provisioned before R-039a was in. A single flag would have told a tenant their rent was handled when it was not. Three tests, one per combination.

**What it decided.**
- **The panel sits above the balance and the pay form.** A tenant who sets this up once never has to read either again, which is why PAY-02 calls autopay a Must rather than a convenience.
- **`loadStripe` is called lazily**, on first use rather than at module scope, so a tenant who never touches autopay never fetches Stripe's script. The portal is mobile-first and read on whatever connection people have (§6.5).
- **The client passes no payer id.** The action re-derives who is asking from the session and scopes by tenant *and* their own leases — either alone is a hole. An id supplied by the caller is an id the caller can change, and this returns a Stripe client secret.
- **Stripe's error message is shown verbatim.** It knows why a card was declined and we do not; a friendlier sentence of our own would tell the tenant something less true.
- **`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is a second name for one value**, and that is a smell accepted for the same reason `NEXT_PUBLIC_OPERATIONS_PHONE` was: a client component cannot read a server-only variable. `.env.example` says the two must match.
- **No panel at all when the key is unset**, rather than a button that cannot work — the same call the vendor help line makes.

**Bugs found along the way.**
- **My own test-isolation failure, caught immediately.** The new `autopayOn` tests mutate the shared payer, and a later spec asserts on its original collection method; it went red on the first run. The original is now captured in `beforeAll` and restored in `afterAll`. Third corner of this suite to teach the same lesson after R-037c and R-102 — the suite shares one database, and a fixture that reaches beyond its own test reaches into somebody else's assertions.

**What it left behind.**
- **Nobody has clicked it.** The gap above is the honest state of this item until somebody confirms a card against the test key.
- **A tenant cannot turn autopay OFF from the portal.** The copy says to contact the office, which is true and deliberate for now — switching a payer back to `send_invoice` has its own refusal rules (D-29, `switchDecision`) and belongs with the rest of R-039a rather than being half-built here.
- Tenant-chosen debit day, the owner's require-full-balance switch, and **the T-2 pre-debit notice** are still outstanding. The last of those is now the most consequential thing missing in the product: autopay works, so money will start leaving accounts automatically, and PAY-02 requires two days' warning that nothing currently sends.

## R-039a (part 4) — The T-2 pre-debit notice, and tests off the cloud database
**Commit:** `916bd66`  ·  **Date:** 2026-08-14

**The T-2 notice.** Autopay started working three commits ago, which means rent now leaves a bank account without the tenant doing anything — and nothing warned them. PAY-02 asks for two days' notice; two days is enough to move money in, or to ring the office before an overdraft rather than after one.

**Only payers genuinely on autopay are warned** — `charge_automatically` **and** a method on file, the same two-part test the pay screen makes. A payer on automatic collection with no method will not be debited; the invoice will fail. Warning them of a debit that cannot happen is worse than silence, because the next message they get says it failed. One test per way that can be wrong.

**It quotes the recurring amount, not a predicted total.** What we know is what we told Stripe to collect. The final invoice can carry a late fee added since, and a pre-debit notice whose number is wrong teaches a tenant to ignore the next one. The email says plainly that anything else outstanding may come at the same time and the receipt will show the exact figure.

**`autopay_predebit` was left unlocked, deliberately.** It sits under "Money" in the category list rather than with the legally significant set — placed there by an earlier item, and the reasoning holds: unlike an entry notice, nothing about it is a statutory service. Turning it off stops the warning, not the debit, which is the tenant's call. Runs 7am property-local, an hour after the late-fee assessment.

**Tests moved off Neon onto a local Postgres.** Same suite, same machine, only the database moved:

| | Neon (us-east-2) | Local |
|---|---|---|
| `escalation.test.ts` | 113s | **0.75s** |
| full vitest (1,321) | ~120s | **39.8s** |
| full e2e | ~20 min | **8.8 min** |

**Integration tests here are latency-bound, not compute-bound.** One page-out is a rota lookup, five writes per recipient per channel, then two more round trips to send — every one a hop to us-east-2 through a pooler. Localhost turns ~50ms into ~0.5ms. This is why a bigger Neon plan was the wrong answer: distance is distance.

**The stronger reason is diagnostic.** A shared remote test database made infrastructure strain indistinguishable from flaky tests. It reached 48,442 delivery rows of test debris, went unreachable mid-sweep once (239 failures, one signature), and starved a 2.4-second test past a 60-second ceiling. Several hours across this session went into chasing "flaky tests" that were never code — including four separate timeout raises that were treating a symptom.

**What it decided.**
- **`.env.test` overrides only the database** and inherits everything else from `.env.local`, because `dotenv -e A -e B` lets the first file win — verified empirically rather than assumed. No secrets duplicated into a second file.
- **Playwright's `webServer` runs `dev:test`, not `dev`.** Otherwise the app under test reads the cloud while the specs read localhost — a split brain where a spec seeds a tenant the app cannot see.
- **`db:migrate:all` and `db:status` exist because a side effect disappeared.** Running the tests used to apply migrations to the Neon dev branch, because that is where they pointed. Now they do not, so a migration could pass locally and leave dev behind unnoticed.
- **Production is not in `db:migrate:all`.** Applying migrations to a database holding real leases is a decision, not a side effect of a convenience script.
- **Schema syncs; data deliberately does not.** Migrations in git are the only thing shared. Test fixtures must never reach production, and production data must never reach a laptop — that is what `NOTIFICATIONS_SANDBOX_TO` exists to prevent.

**What it left behind.**
- **The timeout ceilings raised earlier this session are now wildly oversized** — 90s on escalation, 120s on emergency, 240s on the axe scan, 20s on the soft-delete poll. Harmless, since a ceiling only matters on failure, but their comments cite measurements taken against a remote database and are now historical rather than current.
- Tenant-chosen debit day and the owner's require-full-balance switch are still outstanding on R-039a.
- **Nobody has clicked the Elements enrolment screen yet.** Unchanged from part 3, and still the honest state.

## R-039a (part 5) — The debit day and the full-balance switch: PAY-02 closed
**Commit:** `3a083ce`  ·  **Date:** 2026-08-14

**What it built.** The last two pieces of autopay, and with them PAY-02's Must story is complete: a tenant can enrol, choose when they are debited, gets warned two days ahead, and an owner can refuse part payments.

**The tenant's debit day.** Rent is due on the 1st; plenty of people are paid on the 3rd. Autopay firing on the 1st against an empty account produces a failed debit, a returned-payment fee and a phone call — every month. Letting the payer name the day is the difference between autopay that helps and autopay that manufactures arrears.

**It cannot be any day, and the ceiling is the point.** A debit after the grace period *guarantees* a late fee: the nightly assessment (R-040) reads the same jurisdiction config and does not care that money was already on its way. Offering a tenant a choice that silently charges them for taking it would be worse than offering no choice. `debitDayDecision` reads `graceDays` from the versioned rule (D-4), so the ceiling moves when a statute does rather than when somebody edits a constant.

**No configured rule means no grace to spend** — the only safe day is the due day itself, and the control renders nothing rather than offering a single option. Same refusal-to-guess that late fees, NSF fees and deposit caps all make.

**The owner's full-balance switch.** D-29 makes partial payments a property of the collection method: `send_invoice` allows them, `charge_automatically` cannot. This overrides it for the narrow case it exists for — a tenant on invoicing because they have no card, whose payment plan has already failed once. Off by default, with a hint saying most leases should leave it off, because refusing a part payment from somebody trying to pay something is usually the wrong move.

**Both flags bite on the WRITE path, not the screen.** `requireFullBalance` flows into `validatePaymentAmount`, and the debit day is re-validated in the action. The pay form hides what it should, but a hand-crafted request does not go through the form — and enforcing it in core is the only thing that actually refuses one. The same reasoning `allowsPartialPayment` already carried.

**What it decided.**
- **The refusal message is written for a tenant.** *"Rent would be late by then, and a late fee would apply. Choose day 4 or earlier."* — what happens to them, not which rule fired. No mention of grace periods or jurisdictions.
- **The debit-day control appears only once autopay is on.** Asking somebody to pick a collection day before there is anything to collect with is a setting that does nothing.
- **A day earlier than the due day is refused too** — not unlawful, just money taken before it is owed, which is refused for the tenant's benefit rather than ours.
- **`requireFullBalance` lives on the Lease, not the payer.** It is a decision about a tenancy; a two-payer lease where one may pay partially and the other may not is a distinction nobody asked for and would have to be explained on every screen.

**What it left behind.**
- **Changing the debit day does not yet move the Stripe billing anchor.** The column is recorded and enforced, and the pre-debit notice reads the lease's due day rather than the payer's chosen one — so a tenant who moves their day is warned on the old schedule. Moving the anchor means `updateSubscription` with a new `billing_cycle_anchor` and a proration decision (D-12 says ours, not Stripe's), which is a real piece of work and wants its own item.
- **Nobody has clicked the Elements enrolment screen.** Unchanged since part 3 and still the honest state.

**Follow-up, same day — the anchor actually moves.**

The gap recorded above is closed: choosing a debit day now moves the Stripe subscription, and the pre-debit notice reads the payer's chosen day rather than the lease's. A preference the product records and does not act on is worse than not offering the choice.

**`setBillingAnchor` uses `trial_end`, which looks wrong and is not.** Stripe accepts only `now` or `unchanged` for `billing_cycle_anchor` on an update, so the documented way to shift an existing cycle is to set `trial_end` to the instant the next period should begin. No trial is granted — `proration_behavior: 'none'` means no credit and no charge for the gap. Both the interface and the implementation say so, because the next reader will assume it is a bug.

**D-12 still holds.** Stripe is told WHEN to bill, never asked what the move is worth. Any amount owed for shifted days remains ours to compute and push as an invoice item.

**It never throws into the tenant's response.** The choice is saved and the notice already honours it; a provider being unreachable must not make a saved setting look rejected. R-036's resync reconciles the anchor afterwards.

**Two tests, both halves of a moved day:** the new day warns, and the old day goes quiet. Without the second, a tenant who moved their debit gets two warnings a month and learns to ignore both.


## R-042 (part 2) — Pet rent and flat utility fees, as subscription items
**Commit:** `243f4a4`  ·  **Date:** 2026-08-14

**What it built.** The second of R-042's three parts. `RecurringCharge` has been in the schema since R-002 with `stripePriceId` and `stripeSubscriptionItemId` columns and **no code anywhere** — this fills them. Pet rent and a flat utility fee are now real Stripe subscription items on the lease's subscription, added and stopped from the lease page.

**Stripe may own the repetition here even though D-12 says it may not own the amount.** D-12's line is about statutes: if a rule could change a number, core computes it. No statute touches $35 of agreed pet rent — it is a term of the contract, exactly like the rent, and the rent has been a Stripe subscription since R-034. The line worth holding is that the moment an amount stops being flat it stops being a subscription item, which is exactly why RUBS in the same item is an invoice item instead.

**One reconciler, not three writers.** Adding a charge, ending one, and the nightly billing sweep all call `syncRecurringCharges`, which asks a single question per row — *should Stripe be billing this today?* — and makes Stripe agree. That shape is what makes `endsOn` real rather than decoration: a landlord who says the pet rent stops in March has said something nothing else in the product would ever act on, and a fee that outlives the pet is money taken from a tenant who agreed to no such thing. Three writers each pushing their own change gives three places our row and Stripe can disagree, and the disagreement is money.

**What it decided.** (Recorded as **D-40**.)
- **No monthly `Charge` row.** The projection already handles a subscription line with nothing behind it — it lands in the remainder entry beside the rent, which is R-040b's shape — and minting rows to mirror what Stripe is already billing would be a second schedule to keep in sync with the first.
- **A closed list of two types**, `PET_RENT` and `UTILITY`. A list that admitted `LATE_FEE` would let somebody bill a late fee every month with the jurisdiction cap never once consulted.
- **Ending never prorates.** Rent bills monthly in advance, so the period already invoiced stands and the line simply stops appearing on the next one. A credit for part of a month is a waiver somebody decides on with a reason recorded, not a side effect of a pet moving out.
- **Deactivate, never delete.** "Why was I charged $35 a month for two years" is a question a deleted row cannot answer.
- **The label is required and goes on the invoice.** `Pet rent — Two cats — $35.00/month`, written once in core and repeated verbatim by every surface. "Pet rent $35" for three years with nothing saying which pet was agreed to is the dispute the field exists to prevent.
- **`lease.write`, not `ledger.adjust`.** These are terms of the tenancy, the same kind of fact as the rent amount. `ledger.adjust` is for money that arrived with no processor on the other side — a different risk, and gating this on it would repeat R-040's waiver mistake of locking out the people whose job it is.
- **The first active payer's subscription.** The rule `chargeMoveInProration` already uses. Deciding that a housing authority should be billed for a cat is R-048's to make deliberately.

**What it left behind.**
- **Changing the amount is stop-and-add-a-new-one**, not an edit. Deliberate — the old row records what was agreed and when it changed — but it means two rows on screen where an operator may expect one.
- **`RecurringCharge.dayOfMonth` is still unused.** Stripe bills subscription items on the subscription's own anchor, which is the lease's rent due day; a second day-of-month here would be a schedule nothing reads. Left rather than dropped, because dropping a column is a migration for no gain.

## R-042 (part 3) — RUBS: splitting a utility bill, and who absorbs the vacancy
**Commit:** `b82709d`  ·  **Date:** 2026-08-14

**What it built.** The last of R-042. A `UtilityBill` for a property on one meter — amount, period, method, and **the scanned bill attached as a `Document`** — split across the units and charged on as invoice items. `allocate()` has been in `packages/core/money` since R-002, tested, with a comment naming RUBS as its purpose and no caller. It has one now. So does `JurisdictionRule.rubsPermitted`, which R-010 shipped with a column, a form field and a seed value that **nothing had ever read**.

**The vacant unit's share stays with the owner, and that is the decision that matters most.** The weights are computed over every unit at the property and only the occupied ones are charged. Spreading a vacant unit's share across the tenants makes somebody's water bill go up because their neighbour moved out — an amount they can neither predict nor do anything about — and it is what several states' RUBS restrictions are aimed at. The remainder is named on the bill as `landlordCents` rather than silently dropped, so the split still adds up to the bill and a reader can see where the rest went. There is a test asserting the same three tenants pay the same amount whether or not the fourth unit is occupied.

**Occupant count is the basis landlords reach for first, and this product will not offer it.** `LeaseTenant` is adults-only by design (LEASE-06), so a family of four reads as two. The honest options were a maintained `occupantCount` column that nobody updates when a baby arrives, or nothing — and billing on a stale count is worse than not offering the basis. Equal, bedrooms and floor area are what remain, chosen per bill because the right basis differs by utility.

**Recording and charging are two presses.** The bill is entered, the split is shown against it, and somebody says yes. One press that did both would put every tenant's invoice at the mercy of a typo in an amount field, and a RUBS charge is the one a tenant is most likely to query.

**What it decided.** (Recorded as **D-39**.)
- **Refusal over estimation.** A unit with no square footage cannot be split on square footage; an invented average puts a number on a tenant's invoice nobody can defend. The refusal names the unit and the fix. A recorded **zero** is different from missing and is honoured — a studio has no bedrooms and owes nothing on a bedroom split.
- **An invoice item, not a subscription item.** A RUBS share is a different number every month because the bill is, so D-12 applies in full: core computes it per bill and Stripe is handed a finished figure.
- **The arithmetic is on the charge.** `Water 2026-07-01 to 2026-07-31 — $412.00 × 1,150/4,600 sq ft = $103.00` can be checked against the bill attached to it. "Utility allocation $103.00" has to be taken on trust.
- **The whole split goes to the audit trail**, not just the total — every weight and every share. An entry saying "allocated $412" cannot defend the charge it recorded.
- **Due on the day the period ended**, not the day somebody entered the bill. A late entry must not make the charge look late.
- **Two permissions.** Recording is `property.write`; charging it on is `ledger.adjust`, because one press bills every tenant at the property.
- **`Charge.utilityBillId` is `Restrict`**, like every other evidence key here — the bill *is* the defence of the charge.

**A UX judgement worth recording.** Charging a bill on replaces the button with the split itself, which unmounts the `useActionState` success notice before anyone reads it. Left that way on purpose: the durable record — every share, the owner's portion, who pressed it and when — is a better confirmation than a message that scrolls away, for the one action in this product that bills every tenant at a property at once. The failure path keeps the form mounted, so a refusal still shows its reason. The e2e spec asserts the record rather than the notice, and says why.

**What it left behind.**
- **The bill is attached by picking an already-uploaded document**, not by uploading one here. R-012 owns compression, versioning, EXIF and soft-delete, and a second upload pipeline on this screen would be a copy of all four. The cost is two steps for the operator, and the screen says which.
- **No re-split after a refusal is fixed beyond pressing again.** A refused bill is left unallocated deliberately, so correcting the missing square footage and pressing again works — but nothing tells anybody the bill is sitting there. A `Task` would be the right answer if these start piling up.
- **Move-out proration is still not built** (carried from part 1). `moveInProration` is named for what it does; the mirror image belongs with R-071, where the final balance is settled.

## R-042 (part 3, alongside) — The e2e harness stopped depending on a 2 GB dev server
**Commit:** `b82709d`  ·  **Date:** 2026-08-14

**What it built.** `build:test`, `start:test` and `e2e:server` scripts, and a `playwright.config.ts` that starts a **production build** instead of `next dev`. `E2E_DEV=1` restores the old behaviour.

**Why it is here rather than in its own item.** It was found by the gate refusing to go green for R-042, three sweeps running, and the diagnosis was wrong twice before it was right. Recording it where it was found is worth more than filing it tidily somewhere else.

**The symptom looked exactly like fifty-five broken tests.** A sweep reported `55 failed`, then `197 ✘`, at a different point each run. Every one was `net::ERR_CONNECTION_REFUSED` — the dev server had died and everything after it failed in **under two seconds**, where a real failure takes fifteen to time out. That timing is the tell, and it is the thing to look for first.

**The cause was memory, and the machine said so plainly once asked.** `next dev` keeps the Turbopack compiler, module graph, source maps and HMR state resident: **1.9 GB measured**. Five parallel Chrome workers are ~490 MB each. With three other projects' dev servers also running, swap was **11,697 MB of 12,288 MB used — 95% full**, and macOS killed the largest process. The proof was unambiguous: `npm run build:test` itself came back `Killed: 9`, exit 137. Not a code path in this product at all.

**Two wrong diagnoses worth remembering.**
- **"My concurrent `npm run build` did it."** It genuinely would — `next build` rewrites the `.next` directory the dev server is serving from — and it was true of the first run. It was not the cause, because run two died with nothing else touching the machine. A plausible cause that explains one instance is the most expensive kind of wrong.
- **"The server is on the wrong port."** `ps` showed a `next dev -p 3177`, which looked like a split brain against `baseURL` on 3100. It was another project's server entirely. Reading a process list on a machine running four projects needs the project established before the conclusion.

**A method failure, not just a diagnosis failure.** The first sweep was piped through `grep -E "passed|failed|..."`, so the `[WebServer]` lines matched the filter and the actual failure list was discarded. CLAUDE.md already warned *"read the e2e summary, not the tail of it"*; this is the same mistake wearing a different hat, and the rule now says to write the full log to a file and filter the file.

**What it decided.**
- **Build-then-serve in one script.** `e2e:server` runs `build:test && start:test`, so a stale or missing build cannot silently test yesterday's code. Next's own cache makes the repeat build cheap, and the webServer `timeout` went from 120s to 300s to cover a cold one.
- **`:test` variants, never the bare scripts.** `start:test` carries the same `dotenv -e .env.test -e .env.local` chain as `dev:test`, for the same reason: the server under test must read the same database as the specs, or a spec seeds a tenant the app cannot see.
- **CI-safe without a change there.** `dotenv-cli` skips a missing `.env.test`, and CI's existing `npm run build` step warms the cache the e2e build then reuses.
- **`E2E_DEV=1` kept as an escape hatch**, because the production server has no error overlay and no source maps, and that is genuinely worse for debugging one failing spec.

**Measured result.** 596 tests: **588 passed, 8 skipped, 0 failed, 0 flaky, 4.1 minutes** — against 16+ minutes and a dead server before. The counts reconcile exactly against `npx playwright test --list`, which is the gate.

**What it left behind.**
- **The full sweep should move to CI.** `.github/workflows/ci.yml` has run `npm run test:e2e` on a throwaway Postgres since R-001, so the laptop sweep has been duplicating it. Nothing was changed there this session; the recommendation is now written into CLAUDE.md.
- **The worker count is still Playwright's default** (cores/2 = 5 here). It fits comfortably now that the server is small, but it is the next thing to cap if this machine gets tighter.

## R-032a — Somebody is subscribed to the vendor
**Commit:** `5ae623d`  ·  **Date:** 2026-08-14

**What it built.** Every vendor outcome now raises work in the one queue (D-9), and the two that will not keep until morning also notify. R-025 gave vendors a way to answer and R-032 gave them a way to talk; **nothing was listening to either**. A vendor could accept, decline, propose a different time, message or upload an invoice, and the only trace was an audit row nobody reads.

**A decline is worse than silence, and that is the whole item.** `sweepUnansweredDispatches` finds jobs where `vendorRespondedAt` is null. A vendor who declines **has responded**, so they step straight over that filter: a vendor who ignores us raises a re-dispatch prompt, and a vendor who says *no* raised nothing at all. The job quietly returned to the unassigned queue with its vendor cleared, and an urgent leak sat there overnight with no notification and no task.

**Fixed at the event, not by widening the query.** The sweep exists to notice an *absence* and needs a timer to do it. A decline is a present, timestamped event already in hand, and making an hourly cron responsible for reacting to it would add up to an hour of latency to the one case that cannot afford any. The sweep's query is untouched and still correct for what it is for.

**A second silent hole, found while building the first.** `PROPOSED_TIME` also sets `vendorRespondedAt`, so the sweep steps over it too — and nothing else acted on a proposal either. A vendor offering a Tuesday window was answered by nobody, indefinitely. It now raises the same scheduling task an acceptance does, with a different sentence.

**What it decided.**
- **One helper, five call sites.** `vendorFollowUp()` is the only thing that decides what a vendor event produces. Five inline blocks would drift the first time somebody adds an outcome.
- **Reuses `workorder_redispatch` for a decline** rather than inventing `workorder_declined_redispatch`. The work is identical — pick somebody else off the fallback list — and two types for one job makes a PM decide which list to read. The title says which happened.
- **A declined job keeps its own priority**, unlike R-036b's ready-to-close task which is deliberately ROUTINE. A declined emergency is still an emergency; nothing has been fixed.
- **Only two of the five notify.** A decline (somebody must call another vendor tonight) and an inbound message (a channel nobody reads is worse than none). An acceptance and an invoice are tomorrow's work and live in the queue where tomorrow's work lives — notifying on all five is how a queue trains people to ignore it.
- **SMS on the decline, not on the message.** An email at 6pm about a burst pipe arrives too late to be a notification. A vendor's question can wait until somebody sits down.
- **A new `vendor_response` category**, not folded into `work_order_assigned`. That one is about a job going *out*; these are the replies coming *back*, and an operator who wants the declines without the chatter has to be able to say so.
- **`workorder.write`, not `unit.write`**, for who hears about it — the people told should be the people who can send the job elsewhere. `staffForProperty` gained a permission parameter rather than being copied.
- **An invoice inside the ceiling raises a review task; one over it does not.** The over-ceiling path already moves the job to PENDING_APPROVAL with its own approval task, and two queue rows for one decision is worse than none.
- **The follow-up never throws into its caller.** Every call site is a vendor in a driveway on a magic link who has just done what was asked. Their acceptance happened; an outage on our side must not show them an error. It logs loudly instead, and a test asserts it resolves.

**Bugs found along the way.**
- **`staffForProperty` returned no phone number**, so any template carrying an SMS channel would have recorded a SUPPRESSED row rather than sending — silently downgrading the one notification in this item that most needed to interrupt somebody. Caught by writing the decline test to assert the SMS channel specifically rather than "a notification exists".

**What it left behind.**
- **`markWorkComplete` still raises no task of its own**, deliberately. It already calls `requestVerification`, and R-036b's `workorder_ready_to_close` fires on the tenant's "yes" — the chain exists. What it does *not* cover is a tenant who never answers, which leaves a job in WORK_COMPLETE indefinitely. That is R-032c's territory (the verification link is a dead end for an SMS-only tenant) and is stated here rather than half-fixed.
- **The four other Milestone 2 repair rows are still open** — R-032b, R-032c, R-032d, R-032e.

**Bookkeeping corrected in the same commit.** Row 39 still carried 🟡 R-039 with "Blocked on OQ-11", but OQ-11 was answered by D-29 and R-039a shipped the whole remainder in five parts. Flipped to ✅ with a pointer, since a stale partial marker is how a finished item gets rebuilt.

## R-032b — What the vendor is not told, and a photo that was never actually required
**Commit:** `0440949`  ·  **Date:** 2026-08-14

**Two of this row's four claims were already fixed, and a third was wrong.** Verified each before writing anything, which is the only reason the item is small. Recording what was stale matters as much as what was built — a row that sends the next session hunting for bugs that do not exist costs more than it saves.

- **"The confirmed `scheduledStart`/`scheduledEnd` is never passed to the component"** — it is. The page passes both, converted with `utcToWallClock`, and carries a comment explaining the fix.
- **"The page mixes `toISOString()` with `utcToWallClock` on one screen"** — it does not. Every timestamp on that page is property-local. R-098's vendor-surface pass did both of these; the row was written before it landed and never updated.
- **"The pet warning and entry permission are collected, validated, and then written nowhere"** — **wrong.** All three ticket-creation paths persist them (`ticket.create` in the portal wizard, the emergency path and the phone-logged path), and the PM's screen has rendered both since R-022.

**The real gap was narrower and worse: the vendor never saw them.** The tenant answered, the Ticket stored it, the PM could read it — and the person who actually opens the door was told neither, on every job since R-025. That is the one fact on the vendor page with a physical-safety consequence.

**What it built.**
- **The pet warning renders above the address**, as a bordered note with its own heading. Deliberately *not* a `<details>` like the access codes: a warning you have to expand is a warning that gets missed, and unlike a gate code there is no reason to withhold it until the job is accepted. It reads before somebody sets off, not after they arrive.
- **The entry answer is stated explicitly**, including when it is "no". "The tenant has not agreed to entry when out" and "nobody was asked" are different facts, and a vendor who assumes the first when it is the second drives to a locked door. Null — a staff-raised work order with no ticket behind it — renders nothing rather than guessing.
- **The completion photo is now genuinely required** (MAINT-06), gated on the server.

**D-17 claimed the photo requirement already existed, and it did not.** Its words, used to justify deferring R-028 to Phase 3: *"MAINT-06's 'required completion photo' is already built into R-025's vendor upload."* R-025 built the *ability* to upload; nothing required it. `vendorMayMarkComplete()` only ever inspected status, so a vendor could take a job to WORK_COMPLETE having photographed nothing — the state R-030 then asks the tenant to confirm against, R-031 charges a tenant from, and a deposit dispute is defended with.

**Gated rather than amending D-17 down to match the code.** The reason D-17 gave for deferring R-028 was sound *only if* the claim were true; weakening the requirement to fit reality would retroactively hollow out a decision that is otherwise still correct. Recorded as **D-41**.

**What it decided.**
- **Server-side, not only the button.** The client gate is an affordance; a stale page rendered before a photo was soft-deleted would walk straight past it.
- **A refusal with the fix on the same screen**, never a dead end. D-6's rule still governs: a vendor turned away phones the invoice in, which is the outcome the whole magic-link path exists to prevent. The message names the one missing thing and the upload is directly above it.
- **The staff-side `markWorkComplete` is deliberately NOT gated.** A PM recording what a vendor phoned in is the override, and gating it would strand the job with no way to close it.
- **Four near-misses, each with a test**: an INVOICE is not a completion photo (half of vendors upload the bill first); a soft-deleted photo does not count, since R-012's 30-day undelete leaves the row in place; a photo on another work order does not count; and the photo check runs *before* the status guard so the message names the right missing thing.

**A test-harness note worth keeping.** `revalidatePath` throws outside a request context, so the *success* path of any server action is untestable without stubbing it. Mocked locally in the one file that needed it rather than aliased repo-wide like `server-only` — a global stub would silence cache invalidation everywhere for the benefit of one test. Promote it if a third test wants the same thing.

**What it left behind.**
- **R-032c, R-032d and R-032e** remain — the tenant verification dead end, the vendor link TTL, and the two disagreeing cost functions.
- **The backlog rows are written at filing time and rot.** Two of four claims here were fixed by an item that shipped afterwards, and nothing updated the row. Worth a habit rather than a fix: verify each claim before building, and record which were already true.

## R-032c — One tap, and no login wall
**Commit:** `c32c5bc`  ·  **Date:** 2026-08-14

**What it built.** The verification message now carries a single-purpose link a tenant can answer without signing in. `TENANT_VERIFY` is a new token purpose scoped to one work order, one tenant and one **round**; the page it opens shows what they reported and two buttons.

**What it replaced was worse than nothing.** R-030's SMS linked to `/portal/maintenance/<ticket>`. That page sits behind `requireTenant`, which redirects to `/portal/login` **with no return-to**, and portal login is **email-only** — "enter the email address on your lease". So a tenant with a phone and no email, which is precisely the persona R-021 was built for, could not answer at all. Everyone else got: tap → login wall → leave the thread → find the email → tap → portal home → navigate → find the job → answer. The reply rate *is* the feature, and a work order closed on silence is something R-030 explicitly permits and records as `unverified` — so the cost of this was invisible in the data.

**The answer is a POST, never a GET, and this is the security decision.** The backlog row asked for a token "carrying the answer", so the message would hold two links and the tenant taps the one they mean. That is genuinely one tap and it is unsafe: SMS clients, carrier link-safety scanners and email security gateways all **follow URLs** to check them. A GET recording "yes, it is fixed" would be answered by a scanner before the tenant read the message, and jobs would close themselves. So the token identifies the *question* and the page presents the answers as form submissions. One extra tap, against a work order that closes because a security appliance was doing its job.

**Bugs found while building it.**
- **The tenant's answer would have been recorded as `SYSTEM / anonymous`.** `audit()` resolves its actor from the session, and the entire point of this link is that there is not one. On the single record whose value is that a *named tenant* said the repair was fixed. Fixed with `auditAsTenant`, and attribution is now an explicit argument to the recorder rather than something it resolves — the portal passes `audit` (which also carries IP and user-agent), the link passes the tenant the token names. **Found only because a unit test could not load the module**, which is the same Auth.js-outside-a-request problem `system.ts` was split out for in the first place.
- **`AuthTokenPurpose` is a Prisma enum**, so the new purpose needed a migration. CLAUDE.md's "adding a value to a status enum is never one edit", met again.

**What it decided.**
- **Seven days, the longest TTL in the table.** A tenant is asked once, on a day chosen by whenever the vendor happened to finish; they may be at work, asleep, or away. Every hour shorter is a job closed on silence. Defensible only because of what the token can *do* — one yes-or-no about one work order, opening no portal and moving no money — so a leaked one can at worst answer a maintenance question wrongly, which a PM sees on the timeline.
- **Multi-use until expiry** (D-16's reasoning, re-derived rather than copied): a tenant who taps, gets distracted and returns must not find it dead. The **answer** is once-only regardless, enforced by the unique index on `(workOrderId, round)` — so multi-use means the page reopens, not that the question can be answered twice.
- **Scoped to the round.** A tenant who kept the first text cannot answer the second question with it, or they could close a repair they never saw the second attempt at.
- **The recording logic was extracted before it could drift.** Two doorways, one `recordVerification`. A second copy of the status transition, the round arithmetic, the reopen clearing and the task fan-out is how the two answers start meaning different things.
- **Both answers are equally prominent.** Making "yes" a button and "no" a quiet link would bias the record the product exists to keep honest.
- **A dead link says what to do next**, per branch — expired, already answered, stale round, nothing to confirm. "Already answered" is deliberately not an error: a tenant tapping twice has answered once, and "this link is not working" sends them to the phone, which is the outcome the item exists to remove.

**Two more found by the e2e, which the unit tests could not see.**
- **Answering "no" made the tenant's own link stale, instantly.** A "no" reopens the job and increments `reopenCount`, so by the time the server action re-rendered the page the current round had moved on and the token was a round behind — the person who had just answered was told their link was for an older question. The answered-check now runs BEFORE the staleness check and looks up the TOKEN's round rather than the current one. Only a unit test could not catch this: it needs the render that follows the write.
- **The success notice does not survive the write.** A server action re-renders the page it was called from, so the client-side notice is unmounted before anybody reads it — the tenant taps and lands straight in the already-answered branch. Rather than fight it, that branch became the success screen and now says what they told us: *"You told us it was fixed, so we have closed it off."* Right for the person who just tapped and for somebody reopening the link days later. Same shape as R-042's RUBS panel: the durable record is a better confirmation than a message that scrolls away.

**What it left behind.**
- **A "yes"/"no" texted straight back still reaches nobody.** Deliberate. Inbound SMS threads by phone number and a tenant may have two open jobs, so "yes" is ambiguous exactly when it matters; resolving it needs either a reply-token in the message or a disambiguating question, and both are their own item. The link now makes the answer reachable in one tap, which was the actual barrier — the row's own framing was that the SMS-only tenant had *no* path, and they now have one.
- **The portal's own verify control is unchanged** and still session-authenticated. Two doorways, one recorder.

## R-032a follow-up — the label R-032a forgot, and the type that will not forget again
**Commit:** `f2ba183`  ·  **Date:** 2026-08-14

**A bug found by auditing my own change rather than by a failing test.** R-032a added `vendor_response` to `NOTIFICATION_CATEGORIES`. `getPreferences()` walks every category in that list, so the staff account screen rendered a row for it — labelled with the raw enum name, **`vendor_response`**, because `CATEGORY_LABELS` had no entry.

**Why nothing caught it.** The map was typed `Record<string, string>` and read as `CATEGORY_LABELS[category] ?? category`. Between them, the loose type and the fallback made a missing label compile cleanly and render something that looks deliberate. This is exactly CLAUDE.md's "adding a value to a status enum is never one edit" — the same shape as R-036b's `VERIFIED`, which was in the enum and in neither of the two lists that read it.

**Fixed at the type, not just the instance.** `CATEGORY_LABELS` is now `Record<NotificationCategory, string>` and the `?? category` fallback is gone, so the compiler refuses the next category that arrives without a label. The local `Map<string, PreferenceRow[]>` was widening an already-typed field back to `string` and had to be narrowed too — that widening was the reason the exhaustive type did not bite on its own.

**Checked the rest of the same class while I was there.** The three task types R-032a introduced (`workorder_schedule`, `workorder_vendor_message`, `workorder_invoice_review`) need no label map: the task list and detail pages render `task.title`, which every `createTask` call writes as a sentence. Nothing else keys off the task type.

## R-032d — A link that outlives the job it was sent for, and one that revives itself
**Commit:** `8a46a5d`  ·  **Date:** 2026-08-14

**What it built.** Two changes that look like one item and fix different failure modes.

**The lifetime now tracks the job, not the token.** D-16 fixed a single three-day TTL for every vendor link, and it was tuned for same-week work. Routine jobs are booked out a week, so the link was dead before the vendor arrived. It is now three days for EMERGENCY and URGENT — attended within hours, and a long-lived credential that can reveal a gate code buys nothing by lingering — and a fortnight for ROUTINE. The priority is read from the work order inside `issueVendorLink`, not passed in, so no caller can dispatch a routine job on an emergency's fuse by forgetting an argument.

**And an expired link now reissues itself.** The old dead end said *"call or text the office and we will send a new one"* — a phone call, somebody to answer it, and an invoice retyped by hand, which is the re-keying D-6 exists to prevent. It lands on the two moments a vendor most needs the link: arriving at a job booked a week ago, and sending the invoice at the end of the month.

**Why both, rather than just a longer TTL.** No reasonable lifetime covers "the invoice arrives whenever the vendor gets round to it", and stretching every link to a month would weaken D-16's control set for every job in the product to serve a tail case. Reissue covers the tail; the priority-based TTL covers the common case without a round trip.

**Why reissue is safe.** The new link is texted to the phone number on the vendor record — never handed to whoever opened the dead URL. Somebody holding a stale link therefore gains nothing they did not already have; they cause a text to be sent to the legitimate vendor. That is the ordinary expired-link-and-we-emailed-you pattern, and it is the whole security argument.

**What it decided.**
- **The same gate a live link passes.** `vendorLinkAccess()` is called with the same facts, so a reassigned vendor, a cancelled job and a closed one all refuse exactly as they would have with a valid token. Expiry must not become a way around the access rules.
- **A revoked link is never reissued.** `consumedAt` is how D-16 says to kill a link texted to the wrong number; reviving it would undo that deliberately.
- **Only genuinely expired tokens**, never a live one and never a forged one. Minting a link for a guessed work-order id is the one thing this must not do, and there is a test asserting nothing is minted.
- **One dead link, one text.** Keyed on the expiry instant of the token that was tapped, so a vendor refreshing the page does not send themselves five messages, while a genuinely later expiry gets its own.
- **The same template as a first dispatch.** A vendor should not be able to tell a reissue from an ordinary send — same job, same link — and a second template would drift from the first.
- **`not_actionable` and `unknown` read identically to the vendor**, so a stale URL cannot be used to probe whether a job exists or what state it is in.

**A test that went red for the right reason.** `link.test.ts` asserted expiry by jumping "four days out — past the three-day TTL". That stopped being true for routine work, and the test correctly failed rather than quietly asserting nothing. Rederived from the expiry the mint actually returns, so it cannot rot the next time a lifetime moves.

**What it left behind.**
- **`TOKEN_TTL_MINUTES.VENDOR_WORK_ORDER` is now only the default** that `mintToken` falls back to; the real lifetime comes from `linkTtlMinutesFor`. Left in place because the table is where somebody looks first, and it is still correct for a caller that does not override.
- **R-032e is the last Milestone 2 repair row** — `jobCostCents` and `actualTotalCents` disagreeing while a comment claims they are the same rule.

## R-032e — Two cost numbers, and the comment that lied about it
**Commit:** `8c7c332`  ·  **Date:** 2026-08-14

**No behaviour changed, and that is the finding.** Both functions were already correct and already used correctly. `jobCostCents()` drives the property spend tile, the close screen and the work-order display; `actualTotalCents()` drives every approval and re-approval check. Nothing was calling the wrong one.

**The defect was a doc-comment about money.** `jobCostCents()` asserted it was *"deliberately the same rule as R-026's `actualTotalCents()`... so 'what did this cost' cannot mean two different numbers on two screens."* That is false, and a false comment about money is worse than no comment: it is what a later session reads before deciding which function to call, and R-042's accounting export was the first thing that had to pick.

**They answer different questions and diverge in one case.**

| | recorded parts $1,000, invoice $600 |
|---|---|
| `jobCostCents()` — the books | **$600** |
| `actualTotalCents()` — the control | **$1,000** |

The books must take the invoice: recording $1,000 of expense against a $600 bill overstates a Schedule E return. The ceiling check must take the maximum: either figure exceeding what the owner approved is money they did not agree to, and a vendor whose invoice beats our own recorded actuals is exactly what R-026 exists to catch.

**Unifying either way breaks the other**, which is why "keep both" is the answer rather than a failure to tidy up. On the invoice, a $1,000 job billed at $600 stops tripping a $700 approval ceiling. On the maximum, the tax return claims money that was never billed. Recorded as **D-42**, which also corrects D-19's assumption that one number existed.

**Why the false claim survived this long.** The two agree on every job where the invoice is the largest figure — which is most of them — so nothing ever disagreed on a screen. There is now a test asserting the divergence explicitly, plus one asserting they agree on the ordinary job, so a later unification fails loudly instead of quietly overstating a return or weakening a control.

**The spend tile now says what it covers.** `closedJobCostsForProperty()` takes no period and no entity filter, so the total is every job closed since the property was added. An unlabelled figure on a property page reads like an annual number somebody re-keys into a spreadsheet — the re-keying D-19 exists to prevent. It now says so in one line, and points at R-081 for the real report.

**GATE NOW COMPLETE.** lint, typecheck, build, 1,416 unit tests, and **600 e2e passed / 8 skipped / 0 failed / 0 flaky** reconciling against `Total: 608`. The entry above originally recorded the sweep as outstanding, because it was — it is corrected here rather than rewritten to look as though it always passed.

**Three sweeps died before that one, and the cause was process hygiene, not the code or the machine.** Overlapping background sweeps: `reuseExistingServer: !process.env.CI` means a second run ADOPTS the first run's server on :3100 instead of starting its own, so when the FIRST run finishes, its teardown SIGKILLs the server the SECOND run is still using. Every symptom fitted — SIGKILL, no kernel record, healthy memory, and a different failure point each time depending on when the older run happened to end.

**It was twice blamed on the OS before being established.** What settled it was evidence rather than reasoning: macOS writes memory kills to disk as `JetsamEvent-*.ips`, and this machine has **exactly one, from 09:28 that morning** — the original incident, not any of the evening's. No kernel memorystatus record, no V8 OOM, no stray shells, no cron, `devslot` idle. `Killed: 9` is SIGKILL and names no culprit: a human, a `pkill` and jetsam all produce it identically. Written into the global conventions as its own trap.

**What it left behind.**
- **Per-period and per-entity maintenance reporting is still R-081's.** Deliberately not started here: building it inside a property-page tile is where the duplication D-19 warns about begins.
- **Milestone 2's repair rows are now all closed** — R-032a through R-032e. The next unticked row is R-101, the remainder of the UX and accessibility report.

## R-101 — The live region that was never announcing anything
**Commit:** `b75bb4d`  ·  **Date:** 2026-08-14

**What it built.** The accessibility fix with the widest blast radius in the product, and it is four lines of structure.

**`FormAlerts` inserted the live region together with its text**, and its own doc-comment asserted the messages were *"announced on arrival"*. They generally were not. A live region announces **changes to itself**, so it has to be in the accessibility tree *before* the text lands in it; a region that appears already-populated is a new node rather than a change, and assistive technology routinely says nothing at all. That is one defect in one file reaching **49 components** — every form in the product, including the ones a tenant uses to report a leak and to pay rent.

**Invisible to axe**, which is why it survived R-098's whole review pass and eleven prior sightings. axe scans a static snapshot; it cannot know whether anything was ever spoken.

**Two bespoke sites had the same defect** — the card-fee disclosure on the pay screen and the autopay-day confirmation — and now share a `LiveRegion` primitive rather than being patched five different ways.

**`display: contents` on the wrappers**, because the regions are now always rendered and their parents are `flex flex-col gap-*`. An always-present empty box would otherwise add a phantom gap above every form on every screen.

**Proven by making it fail**, which is the standard R-099 set for exactly this kind of assertion. Reverting `pay-form` to the old shape produced `A live region was CREATED to announce: selecting the card rail on the pay screen (3 → 4)`.

**A weak assertion caught before it shipped.** The first version of the helper asserted only that *a* live region existed. That is worthless on any screen that also renders `FormAlerts` — whose regions are now always present — so it would have passed while the region under test was still being created at announce time. `expectAnnouncedInPlace()` counts regions **before and after** the action instead: what must not change is the *number*.

**What it decided.**
- **One primitive, not five patches.** `LiveRegion` is exported beside `FormAlerts` so the next announcement has an obvious right way to be written.
- **`assertive` only where the user cannot proceed.** A fee that changes what somebody is about to be charged is polite-but-important, not an interruption.
- **The assertion lives beside `expectFocusSurvived`** in `e2e/fixtures.ts`, because they are the same class of check: things an audit tool cannot see, which only fail in use.

**Verifying the row found every claim understated**, which is the reason it was split rather than finished:

| The row said | Actually |
|---|---|
| seven `onClick` steps in the wizard | **22 handlers**, 518 lines |
| eleven `role="status"` regions | **15** |
| ~35 raw `toISOString()` | **40** |
| roll out `expectFocusSurvived` | present in **3 of 33** spec files |

**What it left behind.**
- **R-101b — the maintenance wizard.** 22 `onClick` handlers across seven steps on the tenant's primary reporting path, plus toggle buttons where radios belong and disabled Next buttons that leave the tab order. Deliberately not attempted at the end of a long session: it is a rewrite of the surface a tenant reports a leak on, and half-doing that is worse than scheduling it.
- **R-101c — the display and coverage sweep.** 40 raw `toISOString()` sites, four `friendlyDate` copies, two staff screens rendering UTC in as many words, and rolling both e2e assertions from 3 spec files to 33. The row that filed this said rolling them out *will* turn up real failures; that is the point, and it deserves room to act on what it finds.

## R-101b — The wizard's choices become real radios
**Commit:** `1f673c7`  ·  **Date:** 2026-08-14

**What it built.** Two accessibility fixes on the flow every non-emergency repair goes through, and both are the platform doing work the code was doing badly by hand.

**Every option was a `<button>` styled to look selected.** Visually identical to a radio group, and wrong in four ways that only a keyboard or screen-reader user meets:

- announced as *"button"*, never as *"radio, 3 of 7"* — no way to know how many choices exist or which is current;
- the selected one announced **nothing**: the styling carried the entire meaning, and styling is not exposed to assistive technology;
- no arrow-key navigation, which is how radio groups are operated;
- every option its own tab stop, so reaching Next on the category step took **seven** presses.

A visually-hidden `<input type="radio">` inside the styled label buys all four back from the platform, with no roving-tabindex code to maintain. The `<fieldset>`/`<legend>` around each group was already right and is what makes the group name announced.

**`disabled` became `aria-disabled`.** A disabled button leaves the tab order entirely, so a keyboard user tabs straight past the only thing standing between them and submitting, and hears nothing about why. It now stays focusable, is announced as unavailable, and names the missing thing through `aria-describedby` — into a live region, so the reason is announced the moment it changes rather than merely appearing. That is R-101's primitive being used by the next thing to need it, which is what it was for.

**A near-miss worth recording.** The radios were first hidden with `sr-only`, which is the reflex. `sr-only` clips an element to one pixel, so every real click landed on the *label* rather than the control — browsers forward that, so it looked fine by hand, and automation reported the label "intercepts pointer events". Stretching the transparent input across the label means the thing being clicked **is** the radio. The maintenance spec went from **4.3 minutes of timeouts to 16 seconds**.

**What it decided.**
- **The pre-hydration rewrite was deliberately not attempted.** The row's headline was "seven `onClick` steps", and converting a client-side multi-step wizard into server-rendered forms means URL-driven steps and server-side draft state across them — a feature, not a refactor. R-098 already fixed the case where pre-hydration genuinely carries risk: the emergency path, whose safety instructions had to exist as text immediately. On the ordinary flow the cost is a few seconds of inert UI on a slow phone, against a rewrite of the surface a tenant reports a leak on. Stated here rather than quietly dropped — if it is wanted, it is its own row with its own reasoning.
- **The in-flight Submit stays `disabled`.** That one is correct: it prevents a double-submit, and its label changes to "Sending…" so the state is announced through the accessible name.
- **`Choice` and `NextButton` are local to the wizard**, not promoted to shared components. One consumer each; promote them when a second flow needs the same shape rather than guessing at an API now.

**What it left behind.**
- **R-101c** — 40 raw `toISOString()` sites, four `friendlyDate` copies, two staff screens rendering UTC in as many words, and rolling `expectFocusSurvived()` / `expectAnnouncedInPlace()` from 3 spec files to 33.

## R-101c — One date formatter, and the timezone is not optional
**Commit:** `38a5d54`  ·  **Date:** 2026-08-15

**What it built.** The structural half of the timezone work: one `friendlyDate` in `packages/core/scheduling`, whose `timeZone` parameter is **required**.

**There were four copies, and the defect was visible the moment they were side by side.** One took a timezone. Three did not — and `Intl.DateTimeFormat` with no `timeZone` formats in the *runtime's* zone, which on Vercel is UTC. So a work order closed at 7pm Central on the 14th was shown to staff as the 15th, on the screens where "when did this happen" is the question being asked. Three of the four were wrong, and each looked correct in isolation.

**Making the parameter required is the fix**, not correcting three call sites: there is no overload that guesses and no default that silently means UTC, so the broken version cannot be written again. Same discipline as `businessDate` and `utcToBusinessDate`, which exist because a date read through the wrong reader is wrong by a day (R-036b's entry window, R-042's proration).

**Three list queries now select `timezone`.** A date cannot be rendered in the right zone if the zone was never fetched, and none of the admin ticket, work-order or tenant-ticket queries carried it.

**The row said "40 raw `toISOString()`", and most of them are correct.** Roughly 24 are `@db.Date` calendar days — `lease.startsOn`, `charge.dueOn`, the RUBS period, a warranty's `expiresOn` — where slicing the ISO string is the *right* reader and putting a timezone anywhere near them is R-042's bug. Counting them as defects would have produced 24 changes that each introduced one. Six genuine ones were fixed, chosen by consequence:

| Field | Why it mattered |
|---|---|
| ledger `occurredAt` | a financial record's own date |
| `noticeGivenAt` (×2) | legally significant |
| `waivedAt` | who forgave money, and when |
| photo `capturedAt` | the evidence timestamp PROP-08 says must never be lost |
| RUBS `allocatedAt` | when every tenant at a property was billed |
| work order `closedAt` | the date the cost lands on the books |

**A negative result, recorded rather than dressed up.** `expectFocusSurvived` went from 3 spec files to 7, and **found nothing**. The row that filed this predicted it would turn up real failures; on those four surfaces it did not, because they use `<details>`/`<summary>`, which survives its own activation — R-099's pattern was already holding. Worth saying plainly: a rollout that finds nothing is evidence the earlier fix generalised, not a wasted change, and reporting it as a win would be the wrong record.

**What it left behind.**
- **R-101d, and it is a different defect than this row described.** Three components swap their whole section on success — the tenant's verify panel, the inherited-lease intake panel, MFA enrolment — and each puts `role="status"` on the content that replaces its own container. A live region inside a replaced container is a new node either way, so R-101's fix does not apply; and the control that had focus has just been unmounted, so focus falls to `<body>` and nothing is announced at all. The right instrument is focus management — move focus to the new heading with `tabIndex={-1}` — which announces the whole new context rather than one sentence of it. Named rather than half-fixed.
- **`expectAnnouncedInPlace` is still only in `pay.spec.ts`.** Rolling it wider belongs with R-101d, where the components it would catch actually live.

## R-101d — Focus on a panel that replaces itself
**Commit:** `c0eddb6`  ·  **Date:** 2026-08-15

**What it built.** `useFocusWhen`, and its three consumers: the tenant's "was this fixed?" panel, the inherited-lease intake panel, and MFA enrolment.

**Each of these swaps its whole section on success, and each had `role="status"` on the content that replaced its own container.** That announces nothing. A live region inside a replaced container is a new node either way, so there is no change to report — R-101's fix does not reach this case. And it is worse than silence: the control that had focus was just unmounted, so focus falls to `<body>`. A keyboard user is returned to the top of the document, and a screen reader says nothing at all about whether the thing they just did worked.

**Focusing the new heading announces the whole new context** — the heading, the section it labels, and the text beneath — rather than one sentence of it. `tabIndex={-1}` makes it focusable programmatically without adding a tab stop for everybody else.

**The hazard this had to be designed around.** All three panels also render their done-state on an ordinary page load: a lease whose gaps were settled last week, a job answered yesterday. Focusing then would yank focus away from somebody who had simply navigated to the page. So the trigger is **client action state**, never a server prop — `state.notice` rather than `gaps.length === 0`. The distinction is *"something just happened"* versus *"something happened once"*, and only the first is worth interrupting for. The hook also fires **once**: re-focusing on a later re-render would fight the user for control of their own cursor.

**MFA is the exception, and it is the easy one.** Its recovery codes only ever exist in client action state — they are shown exactly once and never re-fetched — so there is no page-load case to guard against. It also has no heading in that branch, and none was added: the bold notice already is one in everything but markup, and restructuring a screen shown once is more change than the fix needs.

**Proven by making it fail.** Removing the ref from the verify panel produced `Expected: focused / Received: inactive`. Invisible to axe, which scans a snapshot and cannot know where focus went — the same blind spot `expectFocusSurvived` exists for, met from the other direction: that one catches focus being *lost*, this asserts where it *landed*.

**What it decided.**
- **`useFocusWhen` lives beside `FormAlerts` and `LiveRegion`** in `auth-form.tsx`. That file's header still calls it "shared chrome for every auth screen"; it is now the accessibility-primitives module, and the three primitives belong together where the next person looks.
- **The `role="status"` attributes were removed rather than left alongside the focus fix.** Leaving them would imply an announcement mechanism that does not work in this case, which is the kind of comment-that-lies R-032e was about.

**What it left behind.**
- **The accessibility tier is now closed** — R-098, R-099, R-101, R-101b, R-101c, R-101d.
- **`expectAnnouncedInPlace` is still only in `pay.spec.ts`.** The components it would catch are fixed; rolling it wider is cheap whenever somebody is in those files anyway.

## R-043 — The tenant's own statement
**Commit:** `18d306f`  ·  **Date:** 2026-08-15

**What it built.** `/portal/pay/history` — every charge and payment on the tenancy, newest first, with what was owed after each one — and `tenantStatement()` behind it.

**Most of this row already existed, and saying so is the honest version.** The backlog costed R-043 as "tenant-visible ledger + portal payment: current balance, itemized history, one-time payment in ≤3 taps, saved or new method, instant receipt". Reading the pay screen, four of those five were already built by R-035, R-037 and R-040. The one that was not is **history** — and it is the one the row's business claim actually rests on. A tenant could see what they *owe* and never what they have *paid*, so *"did you get my payment?"* — the call this item is justified by — was the single question the portal could not answer.

**The numbers come from the same functions as the staff view, and that is the design.** `tenantStatement()` calls `statement()`, `balanceCents()` and `reversedEntryIds()` — the same three `leaseStatement()` calls, over the same rows. A tenant and a property manager looking at one tenancy must never be shown two different balances: that is the argument in every disputed payment, and losing it costs more than the feature saves. What differs between the two screens is the **wording** (D-10) — "what you paid" rather than "credits", no column headed "running balance" — never the arithmetic.

**A reversed payment stays on the statement and says so.** D-11 makes a correction a new REVERSAL row rather than an edit, so the original is still there; hiding it would make the statement look like it double-counted, and tidying a tenant's payment history is exactly the behaviour the evidence trail exists to prevent.

**Its own page, not another section on `/portal/pay`.** PAY-01 wants paying to be three taps, and a history list above or below the pay button is the thing that pushes the button off a phone screen. The link sits *above* the pay form so a tenant who came to check does not scroll past a payment button to find it.

**A real bug, caught by the test rather than by review.** The description and the "this was later reversed" note shared one `<td>`, so the two facts ran together into a single string — `getByText('Card payment', { exact: true })` could not match, and a screen reader would have read them as one phrase. The description now has its own element.

**What it decided.**
- **Authorization is the payer row, not a scope list.** `leaseStatement()` takes a staff `ResolvedScope`; this resolves the tenant's own active `LeasePayer`, the same check `paymentView()` makes. R-018's rule that the tenant side never falls through to the staff side holds here.
- **Newest-first for reading, oldest-first for arithmetic.** The running balance is computed in core in occurrence order and displayed reversed. The number beside a line is the balance *after* that line whichever way the list is sorted, and a tenant opens this to check the most recent thing.
- **Timestamps are read in the PROPERTY's zone** via `friendlyDate(line.occurredAt, view.timezone)` (R-101c). `occurredAt` is a real timestamp, not a `@db.Date` calendar day.

**What it left behind.**
- **The receipt is still per-payment, not a downloadable statement.** R-046's pay-now magic links are the natural home for that, since they already build a tenant-addressable view of one tenancy.
- **A machine-wide trap, found the hard way and worth writing down.** The first full sweep was SIGKILLed at 100/616 with no failures. It was not the OS: the only `JetsamEvent` file that day was over an hour earlier, memory pressure was `0` at 51% available, and — the tell — **the server survived and the runner died**, the opposite shape of a memory kill. A Playwright runner belonging to a *different project* was alive at the same moment and died with it. The likely mechanism is that both CLAUDE.md files prescribe `pkill -f playwright` before a sweep, and that pattern matches **every project on the machine**. Recorded as the leading hypothesis rather than the established cause, per the rule that a tool which guesses a cause is worse than one that stays quiet. The re-run from a verified-clean machine was **608 passed + 8 skipped = 616**, reconciling exactly, in 3.2m.

## R-031 — Tenant-caused chargebacks
**Commit:** `8736264`  ·  **Date:** 2026-08-15

**What it built.** The path from "this repair was the tenant's fault" to a charge on their account, with a notice and the evidence behind it.

**Almost every part of this already existed and nothing joined them** — the same shape as R-042's `allocate()`. `WorkOrder.tenantCaused` has been written at close since R-002, and its schema comment says it "drives the mid-lease chargeback flow (MAINT-07)". `ChargeType.CHARGEBACK` was in the enum, already labelled *"Repair you were charged for"* in the tenant portal, and already ordered in `DEFAULT_ALLOCATION_ORDER`. `workorder.chargeback_posted` was in the audit vocabulary **and asserted in a test** — with no writer anywhere in the product. A PM could mark a job tenant-caused and the tenant was never billed.

**What was actually missing:** `Charge.workOrderId`, the notice, and any way to get from a work order to a payer.

### The two rules that do the work

**You may bill less than the repair cost. You may never bill more.** Partial fault, betterment — a 12-year-old carpet replaced with a new one is not a 100% tenant cost — and goodwill splits all reduce the number. Nothing raises it above what was spent, because at that point it is a penalty, and a penalty needs a basis in the lease and the statute that this flow does not establish. The amount field is pre-filled with the full cost and editable; the ceiling is enforced in `chargebackDecision`, on the server.

**Nothing is inferred.** The job must be CLOSED, somebody must have chosen `tenant_caused`, and somebody must have typed both an amount and a reason. `unknown` never becomes `tenant_caused`.

### What it decided

- **D-43: its own action behind `ledger.adjust`, not a checkbox on the close form.** `closeWorkOrder` runs on `workorder.write` — the permission a maintenance coordinator holds — and RBAC deliberately keeps `ledger.adjust` away from managers. Posting the charge inside the close would have quietly redefined "can close a job" as "can bill a tenant". The e2e suite proves it: the manager who closes the job never sees the panel.
- **The split costs a guarantee, and the Task pays for it.** A job could now be flagged and never billed. Closing as tenant-caused raises a `workorder_chargeback_decision` Task (D-9), ROUTINE whatever the job's priority was — deciding who pays the morning after a burst pipe is not an emergency, and priority inflation is how a queue stops meaning anything.
- **The Task is raised OUTSIDE the close transaction, deliberately.** `createTask` catches its own unique violation, and a P2002 inside a transaction leaves it aborted at the Postgres level — the COMMIT would then act as a ROLLBACK and silently undo the close. Its own doc-comment warns about this; the close is the fact that must survive.
- **A reason is required** — `workorder.chargeback_posted` joined `REASON_REQUIRED`. The tenant's notice quotes it back verbatim, and a chargeback with no stated reason is indistinguishable from retaliation, which is the claim it will be defended against.
- **One chargeback per job, enforced by a partial unique index** on `Charge.workOrderId`, not by a read-then-write check two concurrent submits would both pass. Same reasoning and same shape as `Charge_one_nsf_fee_per_payment`.
- **The arithmetic is on the charge and on the notice.** `"$60.00 of a $115.00 repair"`. A tenant shown only "$150" reads it as a number we invented; one who can see they were billed $150 of a $412 repair reads it as a decision made in their favour.
- **The notice says disputing is not a failure to pay rent.** Without that line the only way left to disagree is to withhold rent, which is the outcome the notice exists to prevent.

### Two real bugs found along the way

- **`FieldError` had R-101's live-region defect** — it returned `null` with no message and inserted `role="alert"` together with its text, so the region arrived already-populated and announced nothing. R-101 fixed the tenant-facing twin in `auth-form.tsx` and missed this one, which is the error primitive **every admin form** uses: a PM using a screen reader got silence on every validation failure in the back office. Invisible to axe, which scans a static snapshot. Found only because this item added one more caller.
- **A `WorkOrder` has no lease at all.** `ticketId` is nullable, and it points at a `Ticket` whose `leaseId` is also nullable — so for a PM-raised job there is no path to a tenant. Resolved as ticket-lease first (whoever reported it lived there then, and billing the *new* tenant for the old one's damage is the worst outcome available), then the live lease on the unit, then refusal. It never falls back to the most recent ended lease: that would be a query guessing who broke something from a date range.

### What it left behind

- **The charge reaches the tenant's portal when Stripe invoices it, not when it is posted.** D-11 keeps `LedgerEntry` a projection of Stripe and nothing writes it directly, so a chargeback behaves exactly like rent, late fees, NSF fees and RUBS shares. The notice and the message go out immediately, so nobody is billed silently — but the e2e spec asserts the *notification*, not portal visibility, because asserting the latter would be asserting R-035's item.
- **No PDF.** `Notice.documentId` is still never populated anywhere in the product; the entry notice has the same gap.
- **Reversing a chargeback is not built.** D-11 says corrections are reversing entries; a disputed repair charge currently needs the general ledger-adjustment path.

## R-049 — Message templates with merge fields and preview
**Commit:** `d1483e3`  ·  **Date:** 2026-08-15

**What it built.** A managed template library a property manager writes in: `MessageTemplate` and its translations, a closed merge-field catalogue, validation, live preview against a real tenancy, and the approval control that COMM-03's language rule rests on.

### The thing this item is actually about

`packages/core/notifications/templates.ts` has said since R-016 why the product's automated templates are typed **functions** rather than strings with `{{placeholders}}`: *"a template referencing a field the caller does not pass is a build error rather than a rent reminder that says 'Hi undefined'."* That reasoning is correct and unchanged.

**A managed template is a string somebody typed into a textarea. No compiler will ever see it.** So every guarantee the typed version got for free had to be re-earned at runtime, and that — not the CRUD — is the item:

- **A closed catalogue.** `{{tenant.frist_name}}` is refused when it is saved, and the error names the field. It carries **no internal identifiers** (D-10 forbids them in tenant-facing text, and a catalogue that offers one is an invitation) and **nothing requiring a jurisdiction decision** — `balance.late_fee` is deliberately absent, because what a late fee should be is a per-lease, per-day question core answers from versioned rules (D-4/D-12), and a template quoting one would quote a number nobody computed for this tenancy.
- **Validation on save**, because that is the last moment a human is in the room. Preview is optional and send is automated; a typo'd field reaching the send path goes out wrong to everybody at once.
- **A renderer that never prints `undefined` and never prints a blank.** An unresolved field is left standing as its own token and named in `missing`, so the send path can refuse. `"Your lease ends on ."` reads as a broken system; the alternative reads as worse.
- **Preview against a REAL tenancy.** The catalogue's example values would make every preview look perfect, which is the opposite of what a preview is for. A PM needs to see `{{lease.ends_on}}` come out empty on their month-to-month leases *before* sending to four hundred of them.

**Preview and send share one resolver** (`templateValues`). A preview built from different code than the send is not a preview — it is a second implementation that agrees with the first until the day it does not, and that day is the day a message nobody saw goes out.

### What it decided

- **D-44: the managed library does not touch the 13 automated templates.** Letting a database row override an automated key would put the weaker runtime guarantee onto the paths that run unattended. COMM-03 does list rent reminders, and a PM genuinely cannot reword the automated one — recorded as a named gap rather than papered over.
- **`template.approve` is its own privileged permission**, separate from `template.write`. COMM-03's rule comes down to a single `approvedAt` timestamp; if whoever pasted in a machine translation can also set it, the rule is decorative. Managers author templates and cannot sign off legal wording. The product **cannot** verify an attorney read it — it records who claimed so and why, which is why the action is on `REASON_REQUIRED`.
- **An unapproved translation falls back rather than blocking.** Sending it would serve a legal notice whose words nobody with authority read — a mistranslated cure period is not a typo, it is a defective notice the tenant relied on. Refusing to send at all would mean a tenant who chose Spanish silently receives nothing, which is worse than receiving English. So it falls back and reports `unapproved_translation_for_legal`, which is the only way anybody learns the gap exists.
- **Editing a translation clears its approval**, or the stamp keeps vouching for words that have since been rewritten.
- **Merge fields are validated in translations too.** A translator who renders `{{tenant.first_name}}` as `{{nombre}}` ships a message with a visible token in it, and the translation is exactly where nobody would look. The editor says so on screen: *leave the merge fields exactly as they are.*

### Found along the way

- **`argsIgnorePattern` was never configured.** The codebase has written `_previous` since R-008 to mean "this parameter exists because the signature demands it" — every `useActionState` action has one — but the lint rule was left at its default `args: "after-used"`, which only reports *trailing* unused parameters. Since `formData` was almost always used, the `_previous` before it was silently exempt, and the convention looked enforced when it was not. The first action to ignore both parameters produced two warnings for following the same convention as everything around it.
- **Adding a permission requires re-seeding roles.** Roles are data (D-5), so `template.write` existing in `PERMISSIONS` did nothing until `db:seed` ran — the e2e suite failed with a page that simply never rendered its form. Obvious in hindsight and not obvious at 60 seconds of timeout.

### What it left behind

- **Sending from the library is R-044's**, which this was pulled ahead of. The templates render and preview; nothing yet dispatches one to a selection of tenants.
- **`company.phone` is the one merge field with nothing behind it.** `Property` has no contact number; it resolves to null, so the preview shows the token and the send path would refuse. R-081's property contact details is where it gets a value.
- **No template is seeded.** The library starts empty on purpose, exactly as `SCHEDULED_JOBS` and the notification registry do — the first template is the rent reminder somebody retypes every month, and guessing their wording is worse than an empty list.

## R-044 — Rent roll and aged delinquency
**Commit:** `3fb13da`  ·  **Date:** 2026-08-15

**What it built.** The Monday-morning report: every live tenancy with rent, balance, how late it is, autopay, deposit held and subsidy portion; delinquency aged into PAY-06's buckets; a CSV export; and the one press that chases everybody past grace.

### The distinction the whole item is shaped around

**"Which bucket" and "past grace" are different questions.** The 0–5 / 6–15 / 16–30 / 30+ buckets are counted flat from the due date — an operational view of how long money has been outstanding, with no statute involved. *Past grace* is a legal line that moves by jurisdiction, read from the versioned `JurisdictionRule.graceDays` (D-4).

Texas grants **one** day. So a tenant one day late is in the first late bucket **and must not be chased** — and a screen that treats bucket membership as chaseable is chasing tenants who are not late by the only definition that matters. `bucket` and `pastGrace` are computed separately and never derived from one another; `graceDays: null` (a state nobody configured) never resolves to "chase them", the same call `assessNsfFee` and `assessLateFees` already make; and grace is strictly-greater-than, so the last day of the period is still inside it.

**Aged from the OLDEST unpaid charge.** A tenant who has paid this month while March remains outstanding is months late, not current — taking the newest charge reports the exact opposite, which is the shape of error that makes a delinquency report worse than no report. A credit balance is checked first and reports as current, so an overpaying tenant is never listed late because an old charge row is still on the books.

### What it decided

- **Four bulk reads, not a query per lease.** Jurisdiction rules are read once for every state involved and resolved per property in memory. The loop version is 200 round trips at 50 units for a screen somebody opens at 6am every Monday, and it degrades exactly as the portfolio grows.
- **The bulk chase sends to an explicit selection, never to a filter.** A filter re-evaluated at send time can have changed since the page rendered — somebody pays at 6:02am — and the sender would have chased a tenant who is not on the list they were looking at.
- **Past grace is re-checked server-side immediately before sending**, from the same core function the screen used. The checkbox is an affordance; a stale page or a crafted post must not be able to cause a chase.
- **Each lease is authorised against its own property.** "You hold `message.send` somewhere" is not permission to message *here*, and a bulk action taking ids from a form is exactly where that distinction gets lost.
- **A recipient with an unfillable merge field is skipped, not sent.** R-049's renderer reports what it could not fill precisely so this caller can refuse; one tenant receiving "You owe {{balance.total}}" undoes more trust than the whole batch builds.
- **Skips are recorded with reasons, not counted.** "Why did this tenant not get the reminder we sent everybody" is asked three weeks later, and a bare count cannot answer it.
- **Rows that cannot be chased have no checkbox at all**, not a disabled one — nothing the user could do would make them selectable, so a control that looks available and refuses is worse than none. The reason is written into the row instead.
- **CSV is injection-guarded.** Excel, Numbers and Sheets execute a cell beginning `=`, `+`, `-` or `@`; this file leaves the building and is opened by a lender with no reason to distrust it. The realistic vector is not a malicious tenant name but a property called "-Cedar Row".

### Found along the way

- **Three resource-less permission checks, all mine, all the same class.** The page, the export route and the send action each used `requirePermission`/`actorCan` with no resource. A property-scoped manager — the exact person whose job this screen is — was redirected to `/no-access` by two of them and shown a report with no chase controls by the third. The messages inbox documents this trap in its own header; the rent roll is the same shape (a list filtered to what you may see) and repeated it three times. Fixing the action went further than the test required: per-lease authorisation now refuses a lease outside the caller's scope outright.
- **A negative number is not a formula.** The CSV injection guard and `csvCents` were each correct alone and wrong together: a credit balance is negative, `-` is a formula marker, and guarding it made the one column a lender most wants to sum import as text. Caught by a test that renders a credit balance through both functions at once.
- **The first draft of the spec guessed Texas's grace period at five days.** It is one. Every assertion inverted, and the fix was to read the seeded value rather than assume it.
- **A tenant named "Within" collided with the screen's own words.** `getByRole('row', { name: /Within/ })` matched every row, because each renders "still within grace" into its accessible name. Fixture names are stamped now.
- **A pre-existing flake in `properties.spec.ts`, surfaced by this sweep and fixed.** The duplicate-address test drew a random street number out of 9,000 and built its property NAMES from it, then asserted `findFirst({ where: { name } })` was null. One run in nine thousand draws a number a previous run used, finds that run's deactivated leftover row, and fails against somebody else's debris. Its own comment already anticipated address collisions; the names needed the same treatment, and now carry a UUID. This is why a flaky test is read rather than re-run: the sweep still exits 0.

### What it left behind

- **A courtesy reminder before grace has no path here.** This action is the delinquency chase and enforces past-grace; a friendly nudge on day one is a per-tenant message from the thread, which already exists.
- **RPT-02's remainder:** an arbitrary date range and a PDF. This is the live report; "as of last month end" and the printable version are not built.
- **`company.phone` still has nothing behind it** (R-049's gap), so a template using it is skipped by the bulk send rather than sent with a hole.

## R-044 fix — ordinary rent has no Charge row
**Commit:** `4e8497a`  ·  **Date:** 2026-08-15

**What it found.** Building R-045's due-soon notice surfaced that R-044's delinquency aging was silently wrong for the single most common form of debt. D-11/D-40 mint no monthly `Charge` row for the subscription's own rent line — only the exceptions (a late fee, a proration, a chargeback) get one. `delinquencyFor` read only dated `Charge` rows, so a lease with a positive balance and no dated charge reported `current`, 0 days late, regardless of how overdue rent actually was.

**Worse than silence.** A late fee's own `Charge.dueOn` is the day it was *assessed*, not the rent's due date. A tenancy overdue for a month, with a fee posted this morning, had one dated charge (the fee, dated today) — and aged from it, reporting zero days late on the exact day it was accruing fees for being late.

**What it built.** `dueDateOnOrBefore`/`dueDateOnOrAfter` in `packages/core/scheduling` — the same day-of-month clamp `predebit.ts` and R-049's `template-values.ts` each already computed privately, now one tested pair. `delinquencyFor` takes the **earlier** of any dated charge and the nearest rent due date (from `Lease.rentDueDay`/`LeasePayer.debitDay`), never one or the other — so an existing late-fee charge can no longer mask older unlinked rent.

**What it decided.**
- **Documented limitation, not hidden.** The anchor can only reach the *most recent* due date — two unpaid months still under-report as one, because unlinked rent balance is a single number in this schema, not one row per missed period. Stated in `DelinquencyFacts`'s own comment. Closing it fully needs the billing provider to list every open invoice, not the one `getOpenInvoice` returns today.
- **Proven with a realistic fixture.** Every existing R-044 e2e case seeded rent with a manually linked `Charge` row — unrealistic, and it never exercised the actual production shape. A new case seeds an unlinked ledger entry with no `Charge` at all and asserts it ages and becomes chaseable correctly.

**What it left behind.** Itemizing more than one unpaid month by period remains future work, gated on the billing provider exposing every open invoice.

## R-045 — Payment lifecycle notices
**Commit:** `3aca030`  ·  **Date:** 2026-08-15

**What it built.** Three of the five notices PAY-02/NOTIF-03 asks for already existed (`autopay.predebit`, `payment.receipt`, `payment.returned`). This built the other three: due-soon (T-3) / due-date for tenants who have to act themselves, payment-failed with a fix path, and card-expiring-soon from a nightly scan.

### The split between "the product is paying" and "you have to pay"

`payment.due_soon` never fires for a tenant genuinely on `charge_automatically` with a saved method — they already get `autopay.predebit` two days out. Sending both tells an autopay tenant to go pay rent the product is about to collect for them, which reads as the product not knowing its own state. A tenant marked autopay with *no* method on file still gets the due-soon notice, because nothing will actually be collected for them — the same both-halves test `predebit.ts` already makes, applied in the opposite direction.

### A real gap found reading the webhook, not invented

`payment.returned` — R-039's own template — only fires when a payment genuinely *settled and then bounced back*. A first-attempt decline (Stripe's `record_failure`: nothing was ever credited) sent **nothing at all**. A tenant whose autopay card was simply declined learned about it, if at all, from a phone call. `sendPaymentFailedFix` closes it, hooked into the same "outside the transaction, never throwing" branch the receipt and the return notice already use — the failure is the fact; a notification provider being down must not become a reason to retry the whole webhook.

**Caught by its own test before it shipped:** the first draft quoted `$0.00` in the message, because `ledgerAmountCents(intent)` is the *signed ledger movement* — zero by definition for a failed attempt, since nothing was credited — not the amount attempted. `intent.amountCents` (always positive, regardless of kind) is what the tenant actually needed to see.

### Card expiry, read live, never stored

The literal rule is "never store card, bank, or SSN data." `paymentMethodExpiry` is a new `BillingProvider` seam method — read from Stripe (or the simulator) at scan time, never mirrored into this schema, the same architectural instinct D-11 already applies to every other Stripe-sourced fact. Real Stripe: `GET /payment_methods/:id`, `card.exp_month`/`exp_year`, null for a bank-debit method. Simulated: a hash of the payment-method id (D-27 — the simulator must not agree with the decision by construction, so nothing our own code chooses can double as the oracle), spread across eight years from a fixed epoch and exported as `simulatedCardExpiry` so a test can compute the exact expected answer for a given id rather than searching for one.

**This is the row the backlog names separately, and the reason is stated in its own words:** without it, a card silently expiring is indistinguishable from a tenant who stopped paying — the autopay charge fails, `payment.failed_fix` fires, and somebody who has paid on time for three years gets the same message as somebody who has not.

### A real correctness gap found in R-044, already shipped — recorded in its own entry above

Building the due-soon notice required reading how "when is rent due" is computed, which surfaced that R-044's aging silently mis-reported ordinary rent (no `Charge` row at all) as `current`. Fixed and committed separately (`4e8497a`), with its own PROGRESS entry above this one. The fix produced two shared functions, `dueDateOnOrBefore`/`dueDateOnOrAfter` in `packages/core/scheduling`, that `due-notices.ts` uses for the T-3/T-0 matching here.

### What it decided

- **`paymentMethodExpiry` on the provider interface, not a stored column.** Consistent with D-11 and the harder rule underneath it.
- **`payment.failed_fix`'s decline reason is `null` for now**, deliberately not guessed. Stripe's decline codes are not yet parsed out of the webhook payload, and inventing a plain-English translation before the pipeline actually captures the code would be putting words in front of a tenant that nobody verified.
- **The fix-path link points at `/portal/pay`.** A tenant with a balance can retry there today; a dedicated "update your card on file" flow is not built and is left as a named gap rather than implied.
- **No e2e coverage**, matching the precedent both `predebit.ts` (R-039a) and `assessLateFees` (R-040) already set: nightly-job and webhook-only logic with no new UI surface is proven at the vitest level against a real database, not through the browser.

**What it left behind.**
- Stripe decline-code translation for `payment.failed_fix`'s `reason` field.
- A dedicated "update payment method" portal flow — the fix path currently reuses the pay screen.
- Itemizing more than one unpaid rent period (R-044's own follow-up, above).

## R-046 — Pay-now magic links
**Commit:** `e5a73fa`  ·  **Date:** 2026-08-15

**What it built.** `/pay/<token>` — a standalone page that shows a tenant their balance and takes a payment, with no login at all. R-045's rent reminder now carries the link.

### The decision the whole item turns on

The backlog asked for **"a portal session scoped to paying only"**, and that was deliberately not built (D-45). A real session carrying a `scope: 'pay_only'` marker only works if every portal route refuses it — twenty-four `requireTenant` call sites across ten pages — and **any one missed hands a leaked pay link the tenant's messages, papers, maintenance history and lease documents**. That is fail-open, and it is exactly the shape `lib/portal/guard.ts`'s own header warns about.

A token-scoped page is fail-**closed** by construction: there is no session for any other route to trust, so reaching anything else would require deliberately adding a route that reads the token. It is also the third use of a pattern this codebase already runs twice — the vendor link (D-6, D-16) and the verify link (R-032c) — so it inherits their control set rather than inventing one. An e2e test asserts the negative directly: holding a live pay token and navigating to `/portal`, `/portal/messages`, `/portal/papers` and `/portal/pay/history` lands on the login wall every time. **A session-based implementation would pass every other test in that file and fail that one.**

### Tighter than the verify link, in three specific ways, because this one moves money

- **Three days, not seven.** The verify link's blast radius is a wrong answer to a maintenance question; this one shows a balance and takes a payment, so it gets the vendor links' lifetime rather than the verify link's.
- **Scoped to one `LeasePayer`, not one tenant.** A tenant on two tenancies gets a link per payer, and August's link for unit A can neither pay nor display unit B.
- **Refused for a paused tenancy** (PAY-12), a deactivated payer or tenant, and a payer whose `tenantId` changed between issue and use.

### What it decided

- **Revoked and expired are different answers**, because they tell a tenant different things: one says "ask for a new one", the other says "call us". Both are `consumedAt` in the database, so the distinction is drawn from whether the clock actually ran out.
- **Revocation is real, not nominal.** Reissuing kills the previous link (one live link per payer), and `revokePayLinks()` withdraws payment outright — what a legal-action hold (R-047) will need.
- **The write path is SHARED with the signed-in pay screen.** `startPayment` and `startPaymentFromLink` differ only in how they prove the payer; both go through `chargeResolvedPayer`, which is where every number is recomputed from the ledger and the jurisdiction rule. A second copy would be a second place for a stale amount, a missed hold or an unapplied fee cap to live.
- **The token is re-verified inside the action**, not trusted from the page that rendered the form. A page is rendered once and submitted later; a link revoked in between must not still pay.
- **Attribution is to the LOGICAL send key, not a row id.** `notify()` fans one logical notification out to a row per channel, so there is no single `Notification` a link "was sent in" — picking one would be a lie by arbitrary choice. The engine suffixes the channel onto the idempotency key, so storing the base finds every channel's row and answers "did the reminder work" across whichever one the tenant tapped.
- **No pay link when Stripe does not know the payer.** The reminder still goes out — "rent is due" is worth saying on its own — but a link landing on "your payment account is still being set up" is worse than no link.

### Found along the way

- **`verify-link 2.ts` was tracked in git.** A stale duplicate of `verify-link.ts` accidentally committed during R-032c — an older copy predating the `answer` field, imported by nothing. Removed.
- **The route-guard test did its job.** Adding an unguarded public route failed `route-guards.test.ts` immediately and refused to let it ship without a written justification in `PUBLIC_ROUTES`. The exemption now records the full control set and why a session was the wrong instrument.
- **My first cleanup hook deleted rows an append-only table references.** `LedgerEntry`'s `RESTRICT` foreign keys pin the `LeasePayer`, so every test in the new spec reported as failing on an error none of them had anything to do with — the exact trap CLAUDE.md documents. Retire, never delete.

### What it left behind

- **The link is only minted by the due-soon/due-date reminder.** The late-notice ladder and the bulk rent-roll reminder (R-044) still send portal URLs; giving them pay links is a small follow-on wherever those messages are next touched.
- **No "resend my payment link" self-service.** A tenant with a dead link signs in or calls; the office can reissue by re-running the reminder.

## R-047 — Legal-action payment controls
**Commit:** `046f025`  ·  **Date:** 2026-08-15

**What it built.** PAY-12's three per-tenant switches — block online / block partial / certified funds only — the staff panel that sets them, enforcement on both the read and write paths, and the test the backlog demanded by name.

### The test this row asked for, and why it is the one that matters

The row is explicit: *"an autopay charge that fires the morning after a notice is served is a defect with legal consequences — this item must prove, with a test, that pausing actually stops Stripe."*

So the hold is pushed to Stripe **synchronously**, and the test asserts the subscription reports `paused` immediately afterwards **with no sweep having run**. The nightly reconciliation would have got there eventually; eventually is the next morning, and the next morning is when the charge fires.

**It fails loudly.** If the provider does not confirm, `applyPaymentHold` returns an error saying the hold is *not* fully in force. This is the only place in the product that treats a billing-provider outage as a refusal rather than an operational condition to swallow — every other write logs and continues. The difference is that the operator's next action is serving a notice, and they must not take it believing collection is stopped when it is not.

### What each switch actually is

- **Block online** is `collectionPaused`, which already existed and already did both halves — pauses the Stripe subscription *and* is refused by the payment UI. R-047 gave it a reason, a UI, immediacy, and link revocation.
- **Block partial** is the switch the voided-notice problem is really about: in many states accepting $50 against $1,500 after notice restarts the whole process. Deliberately **not** `Lease.requireFullBalance`, which looks like the same thing and is an owner's ordinary commercial preference — lifting a legal hold must not silently clear a setting somebody made for unrelated reasons, and one column could not tell the two apart.
- **Certified funds only** closes every online rail **including ACH**, which is the counter-intuitive one: a bank debit can be *returned days later*, by which point a notice may have been abandoned on the strength of money that never cleared.

### What it decided

- **Three things close together or the hold leaks:** Stripe stops collecting, the payment UI refuses, and live pay-now links are revoked (R-046's seam). The third is the one that was easy to miss — a token minted before the notice is a payment surface sitting in a text message, and **no screen in the product displays it**.
- **Gated on `ledger.adjust`, not `ledger.read`.** Billing re-sync runs on `ledger.read` because whoever can see a lease's money should be able to fix its billing. That reasoning does not reach an action that stops taking somebody's rent in support of an eviction; that is the same class of judgement as a ledger adjustment, and carries the same MFA requirement.
- **A reason is required to lift a hold, not just to place one.** "Why did we start taking their money again" is as much a part of the record as why we stopped.
- **The audit row records what Stripe actually did**, not just what we intended. "We believed this tenancy was held" and "Stripe was told" are different facts and a dispute needs both.
- **The tenant-facing message never names the reason.** An e2e test asserts it contains none of *evict / eviction / notice to vacate / legal action / court / attorney / proceeding*. Two reasons: a payment screen is not lawful service of a notice and must not pre-empt the instrument that is, and the device may be read by somebody who is not party to the case.

### Found along the way

- **The autopay panel still offered to TURN ON automatic payments to a held tenancy** — the exact defect this row is about, reached from the tenant's own pay screen. Found because a locator matched a button that should not have been on the page at all.
- **The simulator reported every subscription as `active`, ignoring a column it selected.** The consequence was asymmetric and invisible: `pause` fired every sweep (harmless), but `resume` could *never* fire, so **lifting a hold silently left Stripe paused**. Fixed per D-27 by answering from `lastSyncAction` — what the simulator was *told* — rather than from `collectionPaused`, the intent column the decision compares against, which would have made both branches unreachable.
- **`applyPaymentHold` takes an injected `AuditWriter`**, following R-032c's precedent: `lib/audit/index.ts` resolves the actor from the Auth.js session and cannot load under Vitest — which would have made the one test this row demands by name impossible to write.

### What it left behind

- **"The case file" is the audit trail for now.** R-083 owns real eviction case files; when it lands, these entries are what it should absorb.
- **No automatic hold.** Serving a notice does not place one — a human decides, deliberately. Wiring R-062's notice generation to prompt for it is the natural follow-on.
- **Certified funds arrive through R-036's offline recording.** Nothing here records the cashier's cheque itself; the switch only closes the online rails.

## R-050 — Owner dashboard
**Commit:** `7f8dd44`  ·  **Date:** 2026-08-16

**What it built.** All seven exception-first tiles (RPT-01, RPT-04): collected vs billed, aged delinquency, open tickets by priority/age with the emergency-urgent >48h glow, vacancies with days-on-market and daily cost, leases expiring ≤90/≤120 days, pending approvals, and renewals & alerts. Every tile is a real link into a real filtered list — no dead-end numbers, the row's own requirement.

### What "no dead-end numbers" actually cost

Of the seven tiles, two had a real query behind them already (aged delinquency via R-044's `rentRoll()`; the Task queue D-9/R-011 built for everything else). The other five needed real work:
- `packages/core/units/vacancy.ts` (new) — `daysOnMarket`/`dailyCostOfVacancyCents`. No new schema field: `Lease.moveOutAt` is already written at the exact moment a unit stops earning rent (`leases/actions.ts`, `auto-make-ready.ts`), so it's the honest "vacant since" rather than a second driftable timestamp.
- `packages/core/leases/expiry.ts` (new) — `daysUntilExpiry`/`expiryWindow`, null for month-to-month by construction.
- `packages/core/maintenance/sla.ts` — `OPEN_TICKET_GLOW_HOURS`/`ticketGlows`, a DIFFERENT CLOCK from R-023's first-response SLA: one measures "did anybody engage", this measures "how long has it been open at all," and a ticket can be on-track by one and glowing by the other at once.
- Four destination pages gained `searchParams` filtering (`/money/rent-roll?bucket=`/`?pastGrace=1`, `/maintenance?glowing=1`, `/leases?expiresWithin=90|120`, `/tasks?type=workorder_approval`).
- Two destination pages are new: `/vacancies` and `/renewals` — neither had a cross-property list view before this item.

### What it decided

- **D-46: "Renewals & alerts" is deliberately narrower than "compliance."** The tile reads `filingCabinetAlertsDue()` (mortgage ARM/balloon dates, insurance renewals) — written and tested at R-015, never called by anything until now. A statutory compliance calendar (permits, certificates, inspections) doesn't exist yet and is R-077's. The tile and its page both say "Renewals & alerts," never "compliance," so the dashboard never claims coverage it doesn't have.

### Found along the way

- **A real, pre-existing access bug: the dashboard's own placeholder page (and, it turned out, the maintenance list page) used a bare `requirePermission('property.read'|'ticket.read')`.** That's a resource-less RBAC check — `can(actor, permission, {})` — which only an unrestricted (`owner`-role) actor can pass; `assignmentCovers` compares `resource.propertyId === assignment.propertyId`, and an empty resource never equals a real property id. Every property-scoped manager — i.e. every manager in a multi-entity portfolio — landed on "You don't have access to that" the moment they signed in, since login redirects to `/dashboard`. This has apparently been true since the placeholder was built (R-007) and since the maintenance list page was built (MAINT-01/02); nothing before this item ever loaded either page as a scoped actor in a test. Fixed both to `requireScope`, the same pattern R-008 already established on every other list page. **Not fixed, flagged instead:** a grep turned up the same bare-`requirePermission` pattern on `/money`, `/workorders`, `/search`, `/jurisdiction`, and the message-template pages, all of which a `manager` role plausibly holds the permission for. Out of this item's scope; worth a dedicated audit item rather than a silent fix bundled into R-050.
- **An accessibility regression in this item's own first draft:** the dashboard's tile grid was a `<dl>` wrapping `<Link>` elements directly, with no `<dt>`/`<dd>` — invalid structure, caught by the shell's own axe sweep (`e2e/shell.spec.ts`, WCAG 1.3.1). Fixed to a `<ul>` of `<li><Link>...</Link></li>`, matching the card-list convention every other admin page already uses.
- **A pre-existing flaky test, unrelated to this item, found only because the sweep happened to run across a UTC/property-timezone boundary:** `e2e/rent-roll.spec.ts`'s `daysAgo()` fixture helper anchors "N days ago" to the machine's UTC calendar date rather than the property's own business date. For several hours a day (whenever UTC has already rolled to the next calendar day but a UTC-negative property hasn't), its "one day late" fixture lands on the SAME business date as "today," collapsing to zero days late and misbucketing as `current`. Root-caused by reading `delinquencyFor`/`bucketFor` — they correctly operate on `BusinessDate` strings throughout, so **this is a test-fixture defect, not a production one.** The exact same fencepost was caught and fixed in this item's own new e2e fixture (`daysAgoAtNoonUtc`, anchored to the property's business date) before it shipped. Recommend the same fix for `rent-roll.spec.ts`'s `daysAgo()` as a fast follow-up — it will keep failing for a few hours a day until then.

### What it left behind

- The four cross-project bare-`requirePermission` sites named above (`/money`, `/workorders`, `/search`, `/jurisdiction`, message templates) are unaudited.
- `rent-roll.spec.ts`'s UTC-anchored `daysAgo()` helper is unfixed — see above.
- No date-range filtering on any drill-down beyond what the tile itself passes; that's RPT-02's/R-076's remainder, not this row's.

## R-050b — Golden Path 2 repair
**Commit:** `7a4905b`  ·  **Date:** 2026-08-16

**What it built.** Nothing new-feature. This is the repair of a real defect found by walking **Demo checkpoint 2** end to end for the first time (D-28) — the checkpoint R-050 defines and that nothing had ever run.

### The bug: the late-fee engine silently did nothing for the common case

`assessLateFees()` (`apps/web/lib/ledger/late-fees.ts`) queried `Charge` rows of `type: 'RENT'` and nothing else. Per D-11/D-40, a `Charge` row is minted for rent only in the exceptions — a move-in proration, a hand-recorded charge. **Ordinary subscription-billed rent, month two onward, the normal case for every lease past its first month, posts as an unlinked ledger entry with no `Charge` behind it at all.** `rentRoll()`'s aging (R-044) already hit this exact gap on the READ side and was fixed by falling back to a `rentDueDay`-derived due date when no dated charge exists. `assessLateFees` was never given the same fix — so it never even selected these leases into its query. PAY-04's grace-period late fee has been silently inert for the entire common case since it shipped.

### Why the fix needed a migration, not a query tweak

`rentRoll()`'s fallback only *reads* a synthetic due date. A late fee has to *anchor* to something: `Charge.assessedOnChargeId` is a real foreign key, used to compute the DELTA of a growing fee rather than recharging the cumulative total each night. Unlinked rent has no `Charge` row to point at.

Added `Charge.assessedOnLeaseId` (the lease, when there's no charge to anchor to) and `Charge.assessedForDueOn` (which rent-due cycle the fee answers to). The second field is the one easy to miss: unlinked rent is a single lease-wide balance, not one row per missed period, so it can represent a *different* overdue cycle each time it's checked — March's debt, paid off, then May's. Without `assessedForDueOn`, a fee assessed against March would be read as "already assessed" against the unrelated May debt, and the delta math would silently zero out a fee that is genuinely owed. A CHECK constraint keeps the two anchors mutually exclusive (`assessedOnChargeId IS NULL OR assessedOnLeaseId IS NULL`).

`assessLateFees` now runs two passes: the original per-charge loop, byte-for-byte unchanged (lower regression risk than unifying it); and a new per-lease pass, scoped to leases that never got a dated `RENT` charge at all, so the two passes never compete for the same debt. The new pass reuses `delinquencyFor()` — the exact function `rentRoll()` already reads from — rather than re-deriving grace/bucket logic, so a lease this pass fires a fee on and the rent-roll screen showing it "past grace" can never silently disagree.

### Verified two ways

- **11 unit tests** (`apps/web/lib/ledger/late-fees.test.ts`, the 6 pre-existing plus 5 new): the fee posts on rent with no `Charge` row at all; idempotent per day; charges the increment on a later day, never the cumulative total; leaves a fully paid balance alone; and — the case `assessedForDueOn` exists for — a later, distinct cycle is not silently netted against an earlier one already assessed and paid off.
- **A full Golden Path 2 walk**, against the simulator (`STRIPE_SECRET_KEY` forced empty under Vitest, same as every other billing test): rent posts on two leases via `invoice.finalized`; autopay collects one via `invoice.payment_succeeded`; the other goes unpaid; on grace+1, `assessLateFees` now correctly fires a 10%-of-balance fee, capped under Texas's 12% ceiling; a pay-now link is minted and resolves to the correct payer; a completed payment (`payment_intent.succeeded`) halts the ladder — the lease is no longer past grace and its balance clears; and `dashboardSummary()`, scoped to the one LLC, shows the right billed total and zero tenancies past grace. Written as a temporary script and deleted after — not a permanent regression test, per how R-036b's own Golden Path 1 walk was recorded.

### What it decided

No new D-number. The schema shape (a second, lease-level anchor alongside the existing charge-level one) follows the precedent `assessedOnPaymentId` already set for NSF fees (R-039a) — a different trigger for the same kind of fee needs a different anchor, added the same way.

### Found along the way, left for a named follow-up

- **The grace-period reminder still mints no pay-now link.** `sendReminders()` — the rent-roll bulk chase, the one a tenant past grace actually receives — does not call `issuePayLink()`. Only the pre-grace due-soon/due-date reminder (`sendDueNotices()`, R-045) does. R-046's own "left behind" note already named this; the Golden Path walk needed to call `issuePayLink()` directly to get a token at all, which is the empirical confirmation the gap is real, not just documented.
- **A cluster of bare-`requirePermission()` call sites on other admin pages** (`/money`, `/workorders`, `/search`, `/jurisdiction`, the message-template pages) — named in R-050's own entry above, not re-litigated here. Same class of bug as the one R-050 fixed on the dashboard and maintenance pages; unaudited.

### What it left behind

- The two follow-ups immediately above.
- No UI surfaces this fix — an owner would see it only as "a late fee that used to never post now posts." No new copy or panel was needed.

## R-051 — Notice delivery proof
**Commit:** `04aa77d`  ·  **Date:** 2026-08-16

**What it built.** COMM-02's proof of service: which methods a state actually permits per notice type, a service record that can hold more than one delivery, the three kinds of proof (photograph, certified-mail tracking, portal read receipt), the first PDF path in the repo, and the notice screens — staff and tenant — that had never existed.

### Service is more than one event, and the schema could only hold one

`Notice` has carried `serviceMethod` / `servedAt` / `proofDocumentId` / `trackingNumber` since R-002, and nothing had ever written the last two. Those columns model ONE service event. Several states require a notice to vacate be both posted on the door AND mailed, and each half has its own separate proof — a photograph for the posting, an article number and a receipt for the mailing. An owner who did the lawful thing could not record that they had.

`NoticeDelivery` is one row per service event (**D-47**). The old columns are kept as the FIRST service, never rewritten by a later one, so every reader written before this item keeps working and list screens sort without a join. The migration backfills a delivery row for every notice already served, so history does not start today.

**Append-only by trigger, with exactly one permitted mutation.** The reasoning that makes `LedgerEntry` and `AuditLog` append-only applies exactly: if "when did we serve it, and how" can be edited afterwards, it is not proof of anything. The exception is `readAt`, which cannot be known at insert time — the tenant opens the notice later, and that opening *is* the proof portal service reached them. The trigger allows one transition, null → a timestamp, and compares the rest of the row as `to_jsonb(NEW) - 'readAt'` against the old, so nothing can be smuggled in alongside it and a column added later cannot silently escape the check. Write-once, so a second view never overwrites the first: the evidence is when they FIRST read it.

**Three CHECK constraints hold the shape each enum value promises** — POSTED_WITH_PHOTO requires a photograph, CERTIFIED_MAIL requires an article number, a read receipt exists only for PORTAL service. In Postgres rather than in the action, because a row claiming POSTED_WITH_PHOTO with no photograph is not a weaker record, it is a false one.

### A mechanic is not a permission (D-48)

`NoticeServiceMethod` has listed PERSONAL / POSTED_WITH_PHOTO / CERTIFIED_MAIL since R-002, and that list only ever meant "these are the ways this product can record proof". It never said any of them was lawful anywhere. `JurisdictionRule.noticeServiceMethods` now carries which methods serve which notice type, as JSON because notice *types* are themselves free-form configuration — a state that invents a new notice must not need a migration, and neither must one that changes which methods serve it.

**Three answers, not two.** `servicePermitted()` returns `true`, `false`, or `null` for "nobody has told us" — the same call R-044 makes with `graceUnknown`. "We do not know what this state allows" and "this state forbids it" are different facts and only one is an accusation against the person serving the notice.

**Recording is never blocked.** Choosing a method Texas does not list produces a loud warning and still records, flagged `permittedByJurisdiction: false`. An owner in an unconfigured state still has to serve notices, and refusing to record what they actually did produces no evidence at all — strictly worse than evidence carrying an honest flag. The verdict is stored as it stood at service and never recomputed, because D-4 says rules apply prospectively: a state that legalises door-posting next year must not retroactively make last year's posting look compliant.

Texas's real rules are seeded from §24.005(f), with **email deliberately absent from the eviction-track notices** — the statute does not name it, and a notice that cannot be proved served starts a clock the landlord cannot defend.

### The first PDF in the repo

`pdf-lib`, chosen over a print stylesheet because the artifact posted on a door has to be *archived exactly as served*. `Notice.documentId` has said "the generated PDF" since R-002; a print-to-PDF route stores nothing, so the only record of what the tenant received would be a template that has since been edited. Generation is idempotent — a second render would produce a different file for the same served notice, and then "which of these did they actually receive" has no answer.

Pure JS, no native binary and no headless browser, so it runs in a Vercel function unchanged. The cost is that pdf-lib draws at coordinates: word wrapping and pagination are the renderer's job, and both are tested — including that a 200-paragraph notice grows past one page rather than being silently clipped, which is the failure mode that looks fine until somebody reads page two in court.

### What else it decided

- **Generating and serving are separate acts**, and the product now says so. The two existing notice writers set `servedAt` in the same statement that created the row — fine for an entry notice delivered to the portal in the same breath, wrong for every notice somebody has to physically take somewhere.
- **`NOTICE_PROOF` is a distinct document type from `NOTICE`.** The notice itself and the evidence it was served are the two separate questions a court asks; conflating them would make "what did we serve" and "did we serve it" the same field.
- **The read receipt is written from the tenant's own authenticated view of the notice text**, server-side before render — never from the list page, never from an open-pixel, never from a client effect. A receipt that depends on JavaScript running is missing for exactly the tenant who disabled it.

### Found along the way

- **A pre-existing iCloud hazard, now confirmed as recurring and damaging.** `verify-link 2.ts` — the stale duplicate R-046 already found and deleted once — had reappeared, along with 167 duplicated files across `node_modules` and `packages/db/generated`, and two byte-identical `.claude/settings 2.json` copies that were *committed* back at R-029 and R-039a. It also corrupted the esbuild binary twice mid-session, each time surfacing as a bogus "you installed esbuild for another platform" error. Cleaned up; the underlying cause is that this repo lives under an iCloud-synced `~/Documents`.
- **Two bugs in this item's own tests, both caught by the tests themselves.** A hardcoded `2026-08-16T09:30` fixture that was genuinely in the future for a Chicago property once the machine passed UTC midnight — the same UTC-vs-property-local fencepost the product's own date helpers exist to kill, committed in a fixture. And an assertion on a success banner that was still on screen from the previous submit, so it passed instantly and raced the action it was meant to wait for; now it waits on server-rendered rows.
- **A regression this item caused, caught by the sweep and fixed.** `entry-notice.spec.ts`'s cleanup did `notice.deleteMany`, which now fails: every served notice carries a `NoticeDelivery` row that RESTRICTs it. That is the design working exactly as intended — proof of service outlives the fixture that produced it, and CLAUDE.md's own rule already says test cleanup must retire rather than delete what an append-only table references. The cleanup now ends the lease and deactivates the property instead.
- **The portal has no password sign-in at all** — it is magic-link only. The first draft of the e2e spec assumed otherwise.

### What it left behind

- **TCPA consent capture is R-051b**, split out deliberately (the row bundles it, but STOP handling was already fully built at R-030 and consent is a different subsystem). Existing tenants will be grandfathered with a recorded `EXISTING_RELATIONSHIP` basis rather than silently losing their rent reminders.
- **No admin UI for the service-method map yet.** Texas is seeded and `validateJurisdictionRule` enforces the shape on write, but configuring a *new* state's service rules means a seed or a direct write — the rule form has no matrix control. The next state added is when that becomes worth building.
- **`Notice` itself is still mutable.** The service record is append-only; the notice body is not. Nothing edits it today, and locking it wants the same "correction is a new row" story the ledger has.
- **No certified-mail API.** The tracking number is typed in and stored; nothing queries USPS for a delivery scan. R-081 owns the physical-mail integration, as the row says.

## R-051b — TCPA consent capture
**Commit:** `3044c97`  ·  **Date:** 2026-08-16

**What it built.** The permission half of a permission/revocation pair that has only ever had the revocation. `TenantConsent`, the basis vocabulary behind it, a send-path gate with its own suppression reason, and the backfill that keeps the existing roster reachable.

### The product had revocation and never had permission

`SmsOptOut` has honoured STOP since R-030 — inbound keyword, carrier callback, send-path check, all of it. Nothing had ever recorded that a tenant *agreed* to be texted in the first place. So the only gate on outbound SMS was withdrawal of a permission the product never established, which is backwards under a statute whose damages are statutory and per-message.

### Consent is a basis, not a boolean (D-49)

"They consented" is unfalsifiable six months later. What answers a claim is *how* it was obtained, so the basis is the row's whole point:

- `EXPRESS_WRITTEN` — shown a disclosure and agreed to it. **The only basis that reaches promotional sending**, and the only one carrying a CHECK constraint that requires the disclosure text. The basis that unlocks marketing is the one that must be able to show what was agreed to.
- `EXISTING_RELATIONSHIP` / `VERBAL` / `IMPORTED` — cover messages about the tenancy and nothing else. `IMPORTED` is deliberately the weakest: it records that somebody *else* claims consent exists.

**Keyed on the tenant, not the phone number** — deliberately different from its sibling `SmsOptOut`, which is a carrier fact about a *number*. A number reassigned to somebody else must not carry the old tenant's consent, and a tenant who changes number must not lose it. One table keyed on either alone cannot express both.

**Append-only by trigger except withdrawal** — `revokedAt` null → timestamp, once, with a required reason, and nothing else on the row may move alongside it. Same shape R-051 gave `NoticeDelivery`, same reasoning: a consent record that can be edited afterwards is not evidence of anything. Re-consenting is a new row, so a permission given, taken back and given again survives intact.

### The grandfathering call, and why it was a judgement rather than a shortcut

Gating without a backfill would have silently switched off rent reminders, maintenance updates and notice delivery for the entire existing roster the moment it shipped, until somebody worked through them by hand. That is a worse outcome than the risk it removes, for messages that are transactional by definition and rest on a relationship the tenant is already in.

So every active tenant with a phone was backfilled as `EXISTING_RELATIONSHIP` / source `BACKFILL`, with a note recording plainly that no disclosure was shown and nobody clicked anything. **The row claims nothing false** — that is the entire benefit of storing a basis instead of a boolean. Promotional sending stays barred to all of them.

### Three suppression reasons that are not each other

`no_consent` is deliberately distinct from `sms_opt_out` and from `preference_off`, because the three have different fixes:

- `sms_opt_out` — the carrier is refusing. The tenant's to reverse.
- `no_consent` — our own gap. Ours to go and close by asking.
- `preference_off` — a choice the tenant made.

Recording either of the first two as the third would hide a real gap behind a preference nobody expressed. Ordering matters too: STOP outranks consent, because a carrier block is a fact about whether the message can be carried at all.

**Staff and vendor SMS is ungated.** An employee is not a residential consumer and a vendor is a counterparty we are transacting with; neither is who the consent regime is written about, and gating them would stop the on-call pager for no benefit anybody can name.

**`PROMOTIONAL_CATEGORIES` ships empty, on purpose.** Every category the product has is about a tenancy the recipient is already in, so all of them are transactional today. The set exists so the first category that *isn't* has to be declared there to work, rather than quietly inheriting a basis that does not cover it. A renewal *offer* is the message it is waiting for.

### Found along the way

- **Four bugs in this item's own tests, each caught by the tests.** `notify()` returns `ChannelOutcome[]` directly, not `{ outcomes }`; `NotificationDelivery` has no `createdAt` and is 1:1 with a notification, so "the newest row for this tenant" is not a query it supports (read it by the returned `deliveryId` instead); the engine takes addresses *on* the recipient rather than looking them up, so a fixture that omits the phone gets `no_address` and never reaches the consent gate at all; and `dispatchPendingNotifications` takes `(now, limit, only)` positionally.
- **One assertion that was testing the wrong thing.** "Consent lets the message through" was written as `status === 'QUEUED'` and failed on `preference_off` — the fixture tenant has no notification preferences and `rent_reminder` is not a locked category, so the preference resolver suppresses it for reasons that predate this item entirely. Rewritten to assert on the *reason* (`not 'no_consent'`), which is the narrow thing this item actually guarantees and does not break the day somebody changes a preference default.

### What it left behind

- **`SmsOptOut` still has no append-only guard.** It carries the same evidentiary weight as `TenantConsent` and can be edited freely. Named here rather than widened silently as a drive-by.
- **There is still no tenant-onboarding form anywhere in the product**, so the row's "captured at onboarding" has nothing to hang off. Capture is a staff action gated on `tenant.write`; a real onboarding flow is whichever item builds tenant creation.
- **No portal-side consent screen.** A tenant cannot see or withdraw their own consent from `/portal` — they can still text STOP, which is honoured, but the two are separate records and only one is self-service.
- **Email consent is modelled and not enforced.** `ConsentChannel` carries `EMAIL` and `VOICE`; the send path gates SMS only, because that is what the TCPA governs and what this row asked for. CAN-SPAM is a different regime with different rules.

---

## R-052 — Immutable communications audit, thread transcript, court-ready ledger statement
**Commit:** `c520386`  ·  **Date:** 2026-08-17

**What it built.** The packet you hand an attorney, an adjuster or a judge: one chronological communications record merged across three tables, a timestamped PDF transcript with delivery metadata, and a statement of account that carries a real balance and embeds the payment processor's own invoices.

### The "immutable audit log" COMM-05 asks for already existed — the gap was a read

COMM-05 reads like an instruction to build a table: *"every message, notice and delivery event writes to an immutable audit log."* Building one would have made the record **worse**.

`Message`, `Notification`, `NoticeDelivery` and `AuditLog` are each append-only by trigger already — R-002, R-016 and R-051 did that work. Copying every row into a fifth table would duplicate evidence into a second place that can drift from the first, and *"which of these two records of the same message is the real one"* is the exact question an evidence trail exists so nobody ever has to ask.

The real defect was that **nothing had ever read those tables together**. A thread transcript showed `Message` rows only — so it omitted every automated notification. Rent reminders, late notices, entry notices and payment receipts are all `Notification` rows, which for an ordinary tenancy is most of what was ever sent. A transcript handed to a court showing a tenant's complaints but none of the eleven reminders we sent them is not a partial record, it is a misleading one: **the omission argues the tenant's case for them.** `packages/core/comms/record.ts` merges and writes nothing.

### The document says no more than the evidence supports

`SENT` in this system has always meant *the provider accepted it*, never *it arrived* — `delivery-status.ts` was built around that distinction at R-040e. So the transcript prints "accepted by the provider", not "delivered". A page that blurred the two would let a landlord tell a court a notice was delivered when all that is recorded is that Twilio took it, and **the transcript's own authority is what would make the overstatement persuasive.**

Three other places take the same posture: an outbound entry with no delivery row says so outright rather than rendering blank (absent and failed must not look alike); an unrecognised suppression reason prints its raw token rather than a friendly guess, so a reason added later and not added here looks unfinished instead of looking explained; and an empty transcript states that it is empty, because "nothing was sent" is frequently the finding somebody asked for.

### The opening balance is why the statement is not a filter (PAY-09)

The obvious implementation of "a statement for a period" is *filter the rows, then run the existing `statement()`*. That produces a document that starts every period at zero.

For a tenant who entered March owing $500, a March statement would close $500 light **with every line on it arithmetically correct**. That is the most dangerous kind of wrong — internally consistent, materially false, and nothing on its face reveals it. `statementForPeriod()` therefore computes the running balance across the entire tenancy and applies the window afterwards, so every figure printed is the real balance on that date.

### "No cryptic codes" is a requirement about the reader

The person the statement has to work for has never seen this system and is reading it once, under time pressure, beside the other side's version. So entry types are spelled out ("Correction of an earlier entry", not `REVERSAL`); a credit balance prints `$25.00 CR` with a footnote rather than a minus sign that reads as a typo; a reversal says it corrects an earlier line **and the corrected line stays visible**, because D-11 forbids editing history and a reader who cannot see the correction cannot check it.

The money columns line up because the statement is drawn in Courier via a new `mono` block kind — padding characters in core, where the alignment can be asserted character-by-character, rather than drawing a table at coordinates in the renderer, where it could not.

### Stripe's invoices are embedded, and the ones we could not get are named (D-50)

D-11 makes Stripe the system of record and `LedgerEntry` a projection of it, so the statement is our *reading* of the evidence and the invoice is the evidence. `getInvoicePdf()` joins the adapter and `appendPdfs()` copies the pages onto the end, so one file carries both.

Every failure degrades to a named gap rather than a thrown export — **silence would be a false claim.** A statement one attachment short with no note reads as "there was no invoice for that line", which is a different assertion from "we could not retrieve it". When an invoice arrives but will not parse, the statement is **re-rendered before archiving** rather than shipped with an attachment list that disagrees with its own contents.

### What it decided

- **Both exports are archived, not regenerated on demand.** The obvious call was the opposite — the source rows are immutable, so why store a derivable artifact? Because the rows **keep arriving**: a transcript exported in March and regenerated in June is a different document, and "which transcript did we give the attorney" then has no answer. Same failure R-051 avoided by archiving the notice PDF instead of re-rendering the template. Neither export is idempotent, deliberately, and that is the difference from `generateNoticePdf` (one artifact, served once, where a re-render would be a falsification).
- **Neither document is linked to the tenant.** A `tenantId` would publish a packet assembled *for a dispute with that tenant* into their own portal papers list.
- **Gated on `message.read` / `ledger.read`, the permissions that already render those screens.** The export discloses nothing the actor could not read one row at a time; what is privileged is that the whole history leaves as a file, so the control is the audit row (`comms.transcript_exported`, `ledger.statement_exported`) rather than a permission no role holds yet.
- **The simulated adapter returns `null` for an invoice PDF, never a fabricated one.** A manufactured document that looks like a provider's is the one thing a court packet must never contain.
- **R-051's renderer was generalized rather than copied.** `renderNoticePdf` is now a wrapper over `renderBlocksPdf`; `NoticeDocumentBlock` is an alias of the shared `DocumentBlock`. Notices behave identically.

### Found along the way

- **A real bug in this item's own first draft, caught by its test.** The statement's continuation line — whose entire job is printing the description that did not fit in its column — was itself run through the truncating layout, so it cut the one thing it was added to show. Now wrapped (`wrapMono`), never truncated.
- **`friendlyTimestamp` under `en-GB` labels an American zone `GMT-5`, not `CDT`.** Technically an offset and useless on a Texas exhibit. Switched to `en-US` for the zone abbreviation; the day/month/year order is assembled from parts, so the output is still `3 Mar 2026`. Also pinned `hourCycle: 'h23'` — the same midnight-becomes-24 trap `localParts` already documents.
- **The environment, not the code: 10 duplicate Prisma query-engine binaries** (190 MB) left in `packages/db/generated/client` by the pre-move iCloud sync. The first e2e run failed all six specs in ~400ms each with `Prisma Client could not locate the Query Engine` — the wall-of-fast-failures signature CLAUDE.md warns is environmental. Regenerated the client and removed the duplicates. The working directory has since been moved off iCloud.

### What it left behind

- **The work-order timeline still has no PDF.** R-032's `workOrderTimelineText` says in its own header that the PDF packet belongs to this item. It is thread-scoped work that this item's backlog line does not name (that timeline is one *incident* for an adjuster and includes internal staff notes; this transcript is one *party's* whole history), and the renderer it needs now exists — mapping `TimelineEntry` to `DocumentBlock` is the whole job. Named rather than done, to keep this item's scope to what COMM-05 and PAY-09 asked for.
- **The embedding path is only exercised against live Stripe.** Demo and e2e run on the simulator, which returns `null`, so those runs exercise the could-not-attach branch and never the copy-pages one. Stated in D-50 as the accepted cost.
- **No page-number index for appended invoices.** The "Underlying records" section lists invoice ids in append order, not "invoice `in_123` begins on page 7".
- **`Notice` itself is still mutable** (carried over from R-051), and the bare-`requirePermission` scoping bug R-050 flagged on `/money`, `/workorders`, `/search`, `/jurisdiction` and the message-template pages is still open.

---

## R-053 — Segment announcements
**Commit:** `e3d81b2`  ·  **Date:** 2026-08-17

**What it built.** A staff-composed broadcast to a segment — all tenants, one property, one metro, or one tag — with per-recipient delivery status shown right after sending. New `/messages/announcements` page and composer, `Property.metro`/`Property.tags` (freeform grouping fields), a new `announcement` notification category, and a second managed-template carrier so an announcement's send preference is independent of a rent reminder's.

### A segment is a filter, and that is a deliberate difference from R-044

R-044's bulk chase sends to an EXPLICIT list of lease ids reviewed on a screen, because "past grace" can change between the page rendering and the button being pressed — somebody could pay at 6:02am, and chasing them anyway is the fair-housing exposure that item is built around. An announcement has no equivalent fact to go stale: "the city is flushing hydrants Tuesday" is true for whoever is a tenant at send time, and the whole point of a segment is that nobody enumerates it by hand. So the recipient set here is resolved as a filter, at send time, against `propertyWhere(scope)` — the same helper every other scoped list in the app already uses — intersected with the chosen segment. A crafted `segmentValue` naming a property outside the actor's scope simply matches nothing; there is no separate list to re-check against.

### "Per-recipient delivery status" already had a table

`Notification`/`NotificationDelivery` (R-016) is already one row per recipient per channel with a real status — `QUEUED`/`SENT`/`SUPPRESSED`/`FAILED` and why. A fifth table for announcement outcomes would have duplicated evidence R-052 already treats as the single source of truth, the exact ambiguity an evidence trail exists to prevent. The send action collects the `deliveryId`s it just wrote, dispatches only its own batch (`dispatchPendingNotifications(..., { deliveryIds })`, never the global queue), reads the final statuses back, and returns them in the same response the composer renders — no persistent "announcement" record, no second read path. Sending it again later, or reading history across sends, is what R-054's message history owns; this item only had to prove the send itself.

### `notify()`'s own category check is why a second template exists

The engine refuses to dispatch when a template's fixed category disagrees with the call's category — the guard that keeps a tenant who muted rent reminders from also losing something unrelated by accident. `comms.managed_template` has been hardcoded to `rent_reminder` since R-044, so it could not also carry an announcement without breaking that guard for the reminder path. Rather than parameterize the category (which would let ANY caller send ANY managed template under ANY category, silently), registered a second carrier — `comms.announcement`, category `announcement`, identical render function — so each managed-template use declares its own preference bucket honestly.

### Metro and tags are freeform on purpose

PRD COMM-04 names "one metro" and "tag" as segments, and neither concept existed on `Property` — the closest field was `city`, and a real metro (Dallas–Fort Worth) spans city boundaries a straight match can't group. Building a canonical geography table or a tag taxonomy for a 10–50 unit portfolio would have been exactly the kind of scaffolding nobody asked for. `metro` is a plain nullable string and `tags` a plain string array, both staff-set on the property edit form; two properties that spell a metro differently just fail to group together on the segment picker, which is visible and correctable, unlike a wrong automatic grouping would have been.

### Found and fixed inside this item: a real accessibility bug

The first draft of the composer hand-wrote `<label>` elements WRAPPING their `<select>`s, matching `RentRollTable`'s existing pattern. That turned out to be a latent bug already sitting in the codebase, just never triggered: a label that wraps its control gets an accessible name computed from the control's own rendered content — for a `<select>`, that pulls in ALL its `<option>` text, not just the currently-selected one. The segment-type select's own "One property" option collided under `getByLabel('Property')` with the global property/entity switcher's unrelated "Filter by property or entity" label, caught immediately by this item's own e2e spec (`e2e/announcements.spec.ts`) rather than shipping quietly. Fixed by switching to `components/form/field.tsx`'s existing `SelectField`, which keeps the label a SIBLING associated by `htmlFor`/`id` — the reuse rung of the ladder turned out to be the accessibility fix too. `RentRollTable`'s "Template" select has the identical latent shape and has simply never collided with another label's text; not touched here, since fixing it is outside this item's scope.

### Found, flagged, not fixed: a shared-database test race

While chasing an unrelated failure in a full local sweep, found that `apps/web/lib/ledger/nsf-fees.test.ts` and `apps/web/lib/jurisdiction/queries.test.ts` each independently picked the literal state code `'YY'` as their own "nothing configured for this state" fixture. Run in the same process with vitest's default file parallelism against one shared test database, `jurisdiction/queries.test.ts`'s "returns null" assertions can observe `nsf-fees.test.ts`'s still-live `JurisdictionRule('YY')` row before that file's own `afterAll` cleanup has run. Reproduced once in a full sweep, passed clean on an immediate rerun, and confirmed by running `jurisdiction/queries.test.ts` alone (also clean) — a genuine test-isolation hazard between two files this item never touched, not something introduced here. Left as a named follow-up rather than fixed under this item's scope.

### What it left behind

- **No bulk tool for metro/tags.** Setting either is one property at a time on the edit form — fine at 10–50 units, a real gap past that.
- **No "how many will this reach" preview.** The composer shows the segment size only in the per-recipient result table AFTER sending, not before — matching this item's S-sized scope, but a PM cannot sanity-check a segment before committing to it.
- **Persistent announcement history is R-054's.** This item proves one send's outcome; re-reading past sends, a shared suppression list, and the bounce/failure→`Task` path all belong to the next item.
- **The `RentRollTable` "Template" select's identical label-wraps-control shape is unfixed.** Flagged in the section above; it has never collided with another label on that page, so it was left rather than widened into this item's diff.

---

## R-054 — Message history, shared suppression, bounce path, unanswered-message sweep, daily digest
**Commit:** `999f2e4`  ·  **Date:** 2026-08-17

**What it built.** Four sub-features named in one backlog row (COMM-07, NOTIF-04, COMM-01), each closing a real gap over machinery that already existed rather than adding new tables:

1. **Announcement history** (R-053's own leftover) — `announcementHistory()` reads the `AuditLog` row every `sendAnnouncement()` already writes, rendered at `/messages/announcements/history`. Portfolio-wide only (`scope.everything`): a segment send carries no `propertyId` a property-scoped manager's own scope could be checked against, and guessing at intersecting `segmentValue` with a scope would mean re-deriving every segment type's own semantics just to answer an authorization question.
2. **Shared SMS suppression** — `deliverOverChannel()` (the one function `notify()` and `sendThreadMessage()` already both route through, per that file's own header) now checks `SmsOptOut` itself for every SMS. `notify()` already checked it before queuing; `sendThreadMessage()` — a staff member's own reply to a tenant — did not, so a number that had replied STOP could still be texted by a human typing a reply. One shared check closes the gap for both today and for anything that calls `deliverOverChannel()` next, and incidentally closes the decide→send race window `notify()`'s own pre-check couldn't (a STOP arriving in the gap between a row being QUEUED and the cron sending it).
3. **Bounce/failure path** — a new Svix-signed Resend webhook (`api/webhooks/resend`), same shape as `api/sms/status` and written ahead of a real sender for the same reason (D-15): the alternative is discovering the event mapping is wrong on the day real mail starts moving. `mapResendEventStatus()` maps `email.bounced`→`BOUNCED` (added to `DeliveryStatus`'s rank, above `FAILED`, so a bounce overwrites a generic failure but a later generic failure can't erase a bounce) and `email.delivered`→`DELIVERED`; everything else (`delivery_delayed`, `complained`, `opened`, `clicked`) is a valid event this column has no verdict for and is left alone rather than guessed at. A hard bounce to a TENANT raises a `tenant_email_bounced` `Task` — **the flag IS the task**, no new column on `Tenant`, exactly what the `Task` model's own D-9 comment already named "bounced messages" as a future view over.
4. **Unanswered tenant messages** — `sweepUnansweredTenantMessages()`, hourly (elapsed-time, not a calendar-day question, same reasoning as `sweepUnansweredDispatches`), raises a `tenant_unanswered` Task for any tenant thread whose newest message is INBOUND and 2+ days old (`UNANSWERED_THRESHOLD_DAYS`, a `ponytail:`-marked constant matching `packages/core/maintenance/sla.ts`'s own precedent — a per-property configurable threshold the moment an owner asks for one). New dashboard tile counts the open ones, same shape as the existing pending-approvals tile.
5. **Daily digest** (NOTIF-04) — `notify()` gained a `digest_batched` suppression branch: for `DIGEST_ELIGIBLE_CATEGORIES` on EMAIL, if the recipient's `digest_daily`/EMAIL `NotificationPreference` is enabled, the individual send is suppressed rather than queued. A new `SCHEDULED_JOBS` entry (`notifications.daily_digest`, 7am local) collects everything batched since ITS OWN last successful `JobRun` for that property and sends one combined email per recipient via the new `notifications.digest_daily` template. See "one flag, two meanings" below for why enabling `digest_daily` is both "batch me" and "send me the batch."

**No schema migration anywhere in this item.** Every piece reuses `Notification`/`NotificationDelivery`, `Message`/`MessageDelivery`, `Task`, `AuditLog`, `SmsOptOut`, and `NotificationPreference` exactly as R-002/R-011/R-016/R-017/R-051b already built them.

### One flag, two meanings, on purpose

The digest's opt-in is the SAME `NotificationPreference` row (`recipientType`/`recipientId`, category `digest_daily`, channel `EMAIL`) read twice: `notify()`'s per-channel decision loop reads it to decide whether to batch a `rent_reminder` (say) instead of sending it now, and the digest job's own call to `notify()` for the digest EMAIL ITSELF resolves through the exact same preference row via the ordinary `resolveChannels()` path — no separate "permission to send the digest" flag exists, because the two questions are the same question asked at different times: "does this person want things batched." A second flag could disagree with the first (batching on, but the digest itself somehow off) for no reason anyone could explain, so there is only one. `defaultEnabled('digest_daily', 'EMAIL')` returns `false` — opt-in, unlike every other EMAIL default in this system — because deciding "your notifications are non-urgent" on someone's behalf is not this product's call to make silently. `channelsFor()` restricts `digest_daily` to EMAIL only, so the per-category preferences screen (which iterates every category × every channel generically) doesn't render an SMS or portal toggle for a digest concept that can never go by either.

### The window is the job's own history, not a guessed 24 hours

`notifications.daily_digest` needs to know "everything batched since I last ran" for each property. Rather than assume a fixed 24-hour lookback — which either double-counts (a tick landing slightly early re-collects what yesterday's run already sent) or drops rows (a missed day means more than 24h of debris, and a fixed window misses the tail) — it queries `JobRun` for its own last `SUCCEEDED` row for that `(jobType, propertyId)` and uses that run's `startedAt` as the window's lower bound. A property's first-ever digest, with no prior `JobRun`, falls back to a plain 24h lookback so it can't pull in months of batched rows predating the preference's existence. `JobRun` already exists purely for the scheduler's own once-per-property-per-day idempotency (R-006) and "a staff member never sees a JobRun" — reading it here is an internal, read-only use of bookkeeping the job runner already keeps, not a new coupling.

### Found while testing: the global-sweep trap CLAUDE.md already names, right on schedule

The unanswered-message sweep's own test — following `sweepUnansweredDispatches`'s pattern of "no filter param, tests would just have to eat the whole table" — took **11 seconds** on its first clean run, immediately recognizable as the exact failure CLAUDE.md's test-suite rules warn about: `Message` is append-only (trigger-enforced) and `Thread` still references it, so neither can be deleted in `afterAll` — meaning every session that has ever run this sweep against the shared test database leaves its fixture threads sitting there forever, stale and eligible, for the NEXT unfiltered sweep to scan. Rather than add a "retire debris older than an hour" `beforeAll` (the fix CLAUDE.md documents for a genuinely GLOBAL sweep spec), `sweepUnansweredTenantMessages()` gained an `only: { threadIds }` narrowing parameter — the same shape `dispatchPendingNotifications()`'s `only: { deliveryIds }` already established — so a test scopes itself to the exact threads it created rather than paying for the whole table. Dropped the suite from 11s to 60ms and, more importantly, stopped it from getting slower every time this test file runs anywhere. The production cron call (`api/cron/route.ts`) passes no `only` and sweeps everything, which is exactly what an hourly cron is for.

### What it left behind

- **The unanswered-message threshold is a flat constant (2 days), not per-property config.** Matches `sla.ts`'s own 4-hour precedent — a number nobody has asked to make configurable yet, upgrade path named in the code.
- **The digest is EMAIL only.** SMS and portal have no batching concept; a digest by SMS would defeat the reason SMS bodies stay short, and there is nothing to batch into a portal notice that isn't already sitting in the portal.
- **`email.complained` (a spam complaint) is received and silently ignored**, same as `email.opened`/`email.clicked`. Named as a real gap, not hidden: a complaint is arguably worse for sender reputation than a bounce and could reasonably get the same Task-raising treatment a future item adds.
- **Digest opt-in has no tenant-facing UI yet.** The per-category preferences screen is staff-only today (`setNotificationPreference` hardcodes `recipientType: 'STAFF'`, per that file's own comment — tenant preferences reach the same table once the tenant portal writes to it). The mechanism works for any recipient type the moment that UI exists; today it is reachable only from the staff account page.
- **No admin control over `DIGEST_ELIGIBLE_CATEGORIES`.** It's a closed set in code (`rent_reminder`, `maintenance_update`, `lease_renewal`, `announcement`, `unit_make_ready`, `compliance_due`, `task_assigned`), matching `LOCKED_CATEGORIES`'/`EMERGENCY_CATEGORIES`' own precedent rather than a database-configurable list.

---

## R-055 — Retaliation-claim guard
**Commit:** `cb2689e`  ·  **Date:** 2026-08-17

**What it built.** RISK-06: a rent increase or an owner's own notice drafted inside a property's retaliation-presumption window now warns with the specific complaint and its date, and refuses to save until a business reason is given and recorded. New `JurisdictionRule.retaliationWindowDays` (nullable Int, D-4; TX seeded 180 per Tex. Prop. Code §92.332(a)), a pure decision module (`packages/core/leases/retaliation.ts`), a database query (`apps/web/lib/leases/retaliation-check.ts`), and the guard wired into the two lease actions that already exist and already do the thing RISK-06 describes.

### Cheap for a different reason than the backlog row expected

The row credited R-052's comms transcript with "already knowing when the complaint arrived." It doesn't — `packages/core/comms/record.ts` merges `Message`/`Notification`/`Notice` into one timeline with no concept of "complaint" distinct from any other message. What actually made this cheap is R-023: `Ticket.habitabilityFlag`, set at intake by `detectHabitabilityLanguage()`, is already the exact structured signal a retaliation guard needs — "the most recent thing this tenant complained about that the law cares about, and when." No new complaint log, no new Ticket field. The only genuinely new fact this item introduces is the WINDOW LENGTH, and that is a jurisdiction number like every other one in this system (D-4): `JurisdictionRule.retaliationWindowDays`, nullable, meaning "not configured" rather than "no window applies" — the same posture `noticeServiceMethods` and `graceUnknown` already take for an unreviewed number.

### Wired into what's real today, not into what R-065/R-066 will build

Neither a non-renewal `Notice` type nor a rent-increase/renewal flow exists yet in this product (R-065 and R-066 are both later, unbuilt rows — R-066's own text says "R-055's retaliation guard fires here"). Rather than ship inert machinery with no caller, the guard was wired into the two actions that ALREADY do, in substance, what RISK-06 describes:

- **`updateLeaseTerms`**, when `rentCents` actually RISES. A correction or a decrease is not the adverse action the statute is worried about, and warning on either would train staff to click through the warning on every ordinary edit.
- **`recordLeaseNotice`**, only when `noticeGivenBy === 'LANDLORD'`. A tenant ending their own tenancy can never be a retaliation claim against them.

When R-065/R-066 eventually build the real renewal wizard and non-renewal Notice, they call the same `retaliationCheckFor()` this item built rather than re-deriving the check — the same "build the shared thing before its second consumer" logic D-9 already established for the one Task queue, just arriving one step ahead of both its future callers instead of zero.

### One audit action, not a flag on the write it rides along with

`lease.retaliation_window_acknowledged` is its own `AuditAction`, in `REASON_REQUIRED`, fired ALONGSIDE `lease.updated` or `lease.notice_given` rather than as a field on either. `lease.terminated`'s own comment already explains why this has to be a separate action: `REASON_REQUIRED` is a set of whole actions, and cannot express "a reason is required only when a warning actually applied." Splitting it out means a retaliation defense is always one query away — `WHERE action = 'lease.retaliation_window_acknowledged' AND entityId = ?` — regardless of which future action (a rent increase today, a non-renewal Notice once R-066 ships) is what triggered it.

### Two real bugs, both in existing UI, neither in the new guard logic

Building the warn-then-confirm flow (same shape as R-027's entry-notice override: nothing is written until the reason is given, "NOTHING is written" on the blocked path) surfaced two defects while wiring it into `lifecycle-panel.tsx`'s pre-existing `NoticeForm`:

- **Pinning `<details open={Boolean(retaliation)}>` directly made React re-assert CLOSED on every render with no warning.** A TENANT-given notice never sets `needsRetaliationAck`, so the moment the success state came back, React would have forced the panel shut — hiding "Notice recorded." (or, after the underNotice swap, the summary paragraph) the instant it should have shown. Fixed by tracking whether the user manually opened it (`onToggle`) and deriving `open = manuallyOpened || Boolean(retaliation)` at render time: this can only ever OPEN the panel, never close one somebody is looking at.
- **React 19 resets an uncontrolled field's DOM value once a form action completes** (the same fact `ScheduleForm` already documents for its own override flow) — without echoing `state.values` back on the retaliation early return, the rent figure that TRIGGERED the warning would vanish from its own input, and clicking "Save anyway" would have silently saved the OLD rent instead of the one under discussion. `LeaseFormState` gained a `values` field, populated only on this one return path, and every affected field in `lease-form.tsx`/`lifecycle-panel.tsx` now echoes it with a re-keyed `defaultValue`.

Both were caught by the e2e spec, not by inspection — proof that the browser-level test is pulling its weight here, same as R-053's accessible-name bug was caught by its own spec rather than review.

### An e2e run under real load, correctly diagnosed rather than "fixed" into a lie

The first full run of `e2e/retaliation-guard.spec.ts` produced a wall of uniform 60-second timeouts on `mobile-chrome` while `desktop-chrome` passed every scenario in under two seconds each - CLAUDE.md's own "a wall of uniform failures is an environment symptom, not a code one" pattern, confirmed rather than assumed: `uptime` showed a load average over 12 with 42 node processes running, including three unrelated stray `playwright test-server` processes left running from two OTHER projects on this machine. Every failure was a generic sign-in redirect timing out — never a retaliation-guard assertion — and running `desktop-chrome` and `mobile-chrome` each in isolation with fewer workers made the flake disappear entirely, then a full clean run (both projects, default workers) passed all 8 in 16.6 seconds once load had settled. The stray processes were left alone rather than killed - they belong to sibling projects, and a bare kill across projects is exactly the cross-project-collision CLAUDE.md warns against.

One real, separate test-authoring bug was found and fixed along the way, unrelated to the environment noise: the e2e spec originally pinned an exact day count (`/10 days after/`) computed by mixing a fixed UTC-midnight action date (`parseLeaseDate`) against a wall-clock-relative ticket `createdAt` (`Date.now() - N days`) - the two can differ by a day depending on what time of day the spec happens to run. The exact boundary arithmetic is already pinned precisely in `packages/core/leases/retaliation.test.ts`; the e2e assertion was loosened to match any day count, since proving the specific complaint and category appear is what the browser test is for, not re-verifying arithmetic already covered at the unit level.

### What it left behind

- **No admin UI shows "which properties have no retaliation window configured."** Every non-TX property is silently unprotected until an owner sets one, discoverable today only by opening each state's rule and finding the field blank.
- **The complaint signal is habitability tickets only.** RISK-06's "complaint or exercise of legal rights" is broader in the statute than what `habitabilityFlag` captures — a written complaint that never became a maintenance ticket, or a fair-housing complaint, raises no signal here. Left as the honest, cheap version the backlog asked for; a broader complaint log is a larger, unrequested item.
- **`updateLeaseTerms`'s value-echo covers eight fields, not all of them.** `requireFullBalance` and `isMonthToMonth` are omitted (the latter is already React-state-controlled and survives regardless); losing either on the rare retaliation round-trip is a much smaller defect than the rent-figure bug this item actually fixed, and `violationsToState`'s OTHER, pre-existing validation-error paths still don't echo at all - a real, separate gap this item did not expand into fixing.

---

## R-056 — Listing creation + hosted listing page
**Commit:** `c7f1cce`  ·  **Date:** 2026-08-17

**What it built.** LEASE-01: a PM creates a listing from a unit (photos, rent, deposit, requirements, pet policy, available date), publishes it, and a hosted `/listings/[id]` page shows it to anyone - with jurisdiction disclosures (deposit cap, fee cap, source-of-income acceptance). New `Listing` model and `ListingStatus` enum (DRAFT/PUBLISHED/UNPUBLISHED), `JurisdictionRule.sourceOfIncomeProtected`, `packages/core/listings` (validation + disclosure text, pure), `apps/web/lib/listings` (queries + actions), admin create/edit pages off the unit detail page, and the public hosted page with its own photo-serving route.

### Live reads, not a copy - twice

Two different pieces of content on the listing, same design call each time. **Photos**: `unitPhotosForListing()` reads the unit's own `UNIT_PHOTO` documents (R-012) at request time rather than copying references onto the `Listing` row - a photo added or retired on the unit shows up (or disappears) on an already-published page with nobody touching the listing. **Disclosures**: composed at read time from whatever the property's `JurisdictionRule` says right now, never stored on the listing at all. This is a deliberate departure from how R-051 handles a `Notice` - that PDF is archived exactly as served, because a notice is evidence of what a specific tenant was told on a specific date, and re-rendering it later would produce a different document for the same served notice. A listing is the opposite kind of thing: a live page describing a still-open offer, and a deposit-cap or source-of-income field an attorney reviews the week after publish should take effect on the page immediately, not wait for someone to notice and republish.

### The one new jurisdiction fact, and the one already-settled precedent it reused

`depositMaxBps` and `applicationFeeCapCents` already existed (R-010) and needed no new field - the listing's disclosure text just reads them. `sourceOfIncomeProtected` is genuinely new: a nullable `Boolean` on `JurisdictionRule`, null meaning "not reviewed" rather than "not protected" - the exact three-state shape R-055 gave `retaliationWindowDays` a day earlier, reused rather than reinvented. Seeded `false` for Texas statewide, with the seed's own comment noting that a city with a local voucher-acceptance ordinance (Austin's is the best known) would need its own `JurisdictionRule` row to override it, the same mechanism any local rule already uses to override a statewide one.

### A genuinely new kind of public route

Every zero-login page that existed before this item - `vendor/[token]`, `verify/[token]`, `pay/[token]` - is public because a **secret in the path** is the credential, and each one's `route-guards.test.ts` entry says so. `/listings/[id]` is public for the opposite reason: there is no secret anywhere in the URL, and the record itself is meant to be publicly readable once published - a listing id is guessable and indexable *on purpose*, which is why its page metadata does NOT set `robots: noindex` the way the token-gated pages do. `publicListing()` is the entire authorization, in one place: it returns a row only when `status: 'PUBLISHED'`, so a DRAFT or UNPUBLISHED listing 404s exactly like a record outside an actor's own scope does everywhere else in this product (ROLE-01) - "not public" and "does not exist" have to read the same to an anonymous visitor, or the response itself would confirm that a guessed draft id belongs to a real row. Photos get their own public route (`listings/[id]/photos/[documentId]`) rather than reusing `api/documents/[id]/file`, for the same reason the vendor magic-link photo route is already separate from it: that route authorizes a SESSION, of which an anonymous visitor has none, and folding a third, session-less branch into it would be exactly the "unauthenticated token falls through to a session-authorized path" shape R-018's own lesson warns against.

### Two bugs, both in the e2e spec, neither in the shipped feature

Both were genuine defects and both are worth naming, because "the app worked, the test was wrong" is still a bug that had to be found and fixed before the item could be called done:

- **The create-redirect wait matched the create page's own URL.** `page.waitForURL(/\/listing\/[a-z0-9]+$/)` matches `.../listing/new` itself - "new" is lowercase letters - so the wait resolved instantly against the page the test was already on and captured the literal string `"new"` as the listing id. `leases.spec.ts`'s own `capturedLeaseId` documents this exact trap and excludes it with `(?!new$)`; missed here only because this was a fresh spec file rather than copied from one that already carried the fix forward.
- **A validation test asserted a message the browser never lets the server render.** `TextareaField`'s `required` attribute is real HTML5 validation - checking "pets allowed" without filling the policy text and clicking submit is blocked by the browser itself, and the click Playwright dispatches never reaches the server at all. The field doing its job as designed is not a bug; the test's assumption that a server round-trip would still happen was. Fixed by testing what the browser actually does (the field reveals on check, and required blocks an empty submit) instead of a server message that HTML5 validation makes unreachable - the server-side check itself (`validateListing`'s petPolicyText rule) is still proven, just at the layer that can actually reach it: `packages/core/listings/listings.test.ts`, not e2e.

### What it left behind

- **No bulk photo reordering or a "primary photo" flag.** `unitPhotosForListing()` orders by `capturedAt`; whichever photo was taken first shows first, with no way to pick a hero image for the listing specifically.
- **No listing history page.** A unit can be listed more than once over its life (re-listed after each vacancy), and each is its own row, but only the single most recent one is ever shown - past listings are queryable but nothing surfaces them.
- **No "how many views" or lead capture on the public page.** It is read-only; a prospective tenant reads it and has to contact the office through some other channel this item does not add.
- **R-057 (syndication) still needs to wire its own delist-on-lease-up.** `ListingStatus` includes `UNPUBLISHED` specifically so that item has a real transition to call when a unit leases up, but nothing in this item calls it automatically - a listing stays PUBLISHED until a person unpublishes it by hand.

---

## R-057 — SimulatedSyndicationAdapter + feed builder
**Commit:** `590884f`  ·  **Date:** 2026-08-17

**What it built.** LEASE-02: a PM sends a PUBLISHED listing to simulated networks (Zillow/Apartments.com/Zumper-class), each visit through that network's own tracked link is attributed back to it, and a lease going ACTIVE on the unit pulls the listing down - locally within the same transaction, off every network within the hour. New `ListingSyndication`/`SyndicationStatus` and `ListingLead` models, `packages/core/listings/feed.ts` (pure feed builder), `apps/web/lib/listings/{adapter,simulated-adapter,provider}.ts` (D-7's syndication adapter), a `lease.activated` emission + consumer, and an hourly reconciliation sweep.

### The first of D-7's three adapters, with no sibling to copy

`SimulatedScreeningAdapter` and `SimulatedESignAdapter` (R-060, R-063) are still unbuilt, so this is the first of the three D-7 names to actually exist - there was nothing in that family to copy structurally. Generalized instead from `SimulatedBillingProvider` (R-034), the one earlier simulator D-7's own convention already governs in practice: mint ids in a realistic shape (`zillow_<hex>`, not `sim-1`), log every call with a `[syndication:simulated]` prefix, say `name = 'simulated'` so no screen can mistake it for the real thing, and **hold no state of its own**.

### D-27 earns its keep on a brand new table

"Is this listing live on Zillow" could have been answered by `Listing.status` alone - PUBLISHED means yes, anything else means no. That would have been D-27's exact documented mistake: the Stripe simulator once answered from `lease.rentCents`, our own current row, and agreed with us *by construction* until a test that should have caught drift could not. `ListingSyndication.externalId`/`lastFaultCode` instead record what the simulated network **said**, on its own row, independent of what we meant to publish - so "we unpublished it" and "the network has actually taken it down" are two different facts that can genuinely disagree, which is the entire reason the delist sweep below has something real to reconcile.

### Delist-on-lease-up, split exactly at the transaction boundary

`lease.activated` was already a name in the closed event vocabulary (`packages/core/events/types.ts`) and had never once been emitted - this item is what finally wires it, inside `changeLeaseStatus`'s own transaction, the same instant the unit flips to OCCUPIED. A new consumer (`delist-consumer.ts`, same shape as R-023's triage consumer) reacts by flipping the unit's PUBLISHED listing to UNPUBLISHED **and nothing else** - no provider call happens inside that transaction, deliberately. `send.ts`'s own header already states the reason for notifications: a network call inside a database transaction holds a pooled connection open for the length of a third party's outage. The simulated adapter would never actually make that true, but the shape has to already be correct for the day a real driver (Phase 3, partner-gated on an aggregator agreement) replaces it - D-7 calls these adapters "contract fixtures for future real drivers" for exactly this reason. Telling each network is `delist-sweep.ts`'s separate job, hourly, alongside the other elapsed-time sweeps (`sweepUnansweredDispatches`, `sweepUnansweredTenantMessages`) - well inside LEASE-02's own "≤24h" and PRD's stated "within 1 hour."

The sweep is self-healing without any retry bookkeeping of its own: its query is `ListingSyndication.status = LISTED AND listing.status = UNPUBLISHED`, so a network that faults this hour is still exactly as findable next hour - the same "the query IS the queue" shape `sweepUnansweredDispatches` already uses for re-dispatch.

### Lead-source attribution, kept honestly small

No `Lead` or `Inquiry` entity exists anywhere - not in `schema.prisma`, not in the master PRD's own canonical entity list. R-058 ("prospect pipeline + identical auto-sent pre-screening questions") is the backlog's own named home for one, two rows down from this item. Building a rich lead record here - name, email, message, a pipeline stage - would have been reaching into R-058's job before it exists to disagree with. `ListingLead` is deliberately bare: `listing`, `source`, `occurredAt`, nothing else. The entire attribution mechanism is that `buildFeedEntry()` gives every network its own tracked path (`/listings/[id]?src=<network>`), and the public page records which one a visitor arrived through - "direct" when there is no `src` at all, recorded rather than skipped so "how many visits had no attributable source" stays answerable. This is the same "build the shared thing before its second consumer" call D-9 already made for the one Task queue, one step further upstream than usual: R-058 gets a real table with real data the moment it needs one, instead of inheriting either nothing or a shape this item would have had to guess at.

### What it left behind

- **Fault injection is a constructor seam, not a way to exercise it from the running product.** `SimulatedSyndicationAdapter`'s `fault` callback is real and tested (`simulated-adapter.test.ts` proves timeout/malformed-response/partial-failure all work, per-network, per-operation), but nothing wires it to a staff-visible toggle - a PM cannot make a listing fail on purpose to see what the retry path looks like. Tests construct their own faulting instance; the wired production adapter never faults.
- **No feed-format driver exists, by design** (D-7: Phase 3, partner-gated). `FeedEntry` is this build's own internal shape; mapping it to whatever a real network's actual feed format requires is entirely unbuilt, and no format (RETS, RESO Web API, an ILS XML feed) was ever specified to build toward.
- **A listing can be sent to a network more than once if it is republished after being unpublished.** Re-syndicating after a `PUBLISHED -> UNPUBLISHED -> PUBLISHED` cycle creates a fresh `LISTED` row (via the same unique-key upsert) rather than distinguishing "never sent" from "sent, taken down, sent again" - the history of a listing's syndication is whatever the single current row says, not a log of what happened.
- **No admin visibility into `ListingLead` beyond a same-listing count.** The "visits by source" panel on the listing detail page is the only read; there is no cross-listing or cross-property view of which networks are actually producing traffic.

---

## R-058 — Prospect pipeline + identical pre-screening questions
**Commit:** `ee9b2b9`  ·  **Date:** 2026-08-17

**What it built.** LEASE-07: a visitor's inquiry on a published listing creates a `Prospect` (the named person R-057's own note promised, separate from `ListingLead`'s bare anonymous visit log), an identical five-question pre-screen invite (move date, occupants, pets, income range, prior evictions) goes out automatically over a single-use token, and staff track the pipeline (INQUIRY → PRE_SCREENED → SHOWING → APPLIED → SCREENED → APPROVED → SIGNED) from a new `/prospects` list and detail page. New `Prospect`/`ProspectStatus` model, `PROSPECT_PRESCREEN` auth-token purpose (14-day TTL), `PROSPECT` notification recipient type, a fixed `prospect.prescreen_invite` template, and public pages at `/listings/[id]` (inquiry form) and `/prescreen/[token]` (answers).

### Identical wording is the fair-housing requirement, not a preference

The five questions are a **fixed code template**, not a PM-editable managed one (R-049's own system). Two independent reasons landed on the same answer: fair housing requires every inquiry to see the exact same wording, so an editable version would be the wrong tool even if it fit technically - and it doesn't fit technically anyway, since `renderForRecipient`'s managed-template path renders against a `TenancyRef` a prospect (no lease, no unit yet) simply doesn't have. `Prospect` itself stayed the honestly-scoped record R-057 named for it: `ListingLead` is untouched, still just `listing`/`source`/`occurredAt`; a `Prospect` row is created only when a real name and a real email-or-phone are actually submitted.

### The Auth.js/Vitest split, now a repeatable pattern

A single file mixing a public, session-less action (`submitInquiry`) with a staff action that calls `audit()` (`advanceProspectStage`) fails to import under Vitest for **every** export in the file - `audit()` lives in `lib/audit/index.ts`, which transitively pulls in Auth.js, and Auth.js cannot load outside a real request context. The fix is a physical file split (`actions.ts` public / `staff-actions.ts` staff), not a runtime guard, and this is now the second time the exact same split has paid for itself - R-032c's `verify-link-actions.ts` vs. its staff counterpart drew the identical line for the identical reason. A second, adjacent constraint earned this item: `next/headers`'s `headers()` throws outside a real request scope under Vitest with no workaround, so `submitInquiry` (IP-rate-limited via `clientIp()`) is e2e-only by construction - documented in `prospects.test.ts`'s own header rather than rediscovered next time something reads `headers()`.

### Two real bugs, both caught by e2e and neither by inline review

The prescreen success screen never rendered: `submitPrescreenAnswers` wrote the DB correctly but never called `revalidatePath`, so the Server Component reading `prescreenLinkStatus()` on every request had no reason to refetch after the client-side `useActionState` update landed - the "already answered" success branch was dead code no test reached until e2e drove a real browser through it twice. Separately, the admin detail page's three-way ternary checked `preScreenSentAt` (was an invite ever sent) **before** `preScreenRespondedAt` (did they actually answer) - a prospect who answered showed "Not sent yet." instead of their real answers whenever the two facts diverged, which is exactly what happens for any prospect whose token was minted outside the normal invite flow (the e2e spec's own fixture, and conceivably a resend edge case later). Fixed to gate on `answered` first, `preScreenSentAt` only as the fallback message underneath it.

### The rate-limit bucket local e2e traffic didn't expect

Local e2e traffic carries no `x-forwarded-for` header, so `clientIp()`'s documented fallback resolves to the loopback address - observed as `prospect-inquiry:::1`, not the `:unknown` its own comment assumed. Every anonymous inquiry across every run of the spec, in every browser project, therefore shared **one** `RateLimitCounter` row, and enough manual re-runs during this item's own debugging tripped `RATE_LIMITS.prospectInquiry` (5 per 15 minutes) for real - a genuine rate limit doing its job, not a flake. `e2e/prospects.spec.ts` now clears that bucket by key prefix in `beforeAll`. Production behind Vercel always has a real per-visitor IP, so this collision is local-only, but the pattern (any public, IP-rate-limited action's e2e spec needs the same clearing) is worth remembering before it costs a debugging pass again.

### What it left behind

- **No resend control for a bounced or never-answered invite.** `sendPrescreenInvite` is exported specifically so a later "resend" button has something to call; nothing calls it a second time yet.
- **No automation past `PRE_SCREENED`.** Showing, applied, screened, approved and signed are staff-recorded status only (`advanceProspectStage`), same posture the page's own copy states plainly - R-059 (online application) and R-064 (showings) are where those stages actually get built out.
- **No duplicate-prospect detection.** The same person inquiring on two listings, or twice on one, creates two independent `Prospect` rows with no merge or cross-reference.

---

## R-059 — Online application, one per adult 18+
**Commit:** `fc7d572`  ·  **Date:** 2026-08-18

**What it built.** LEASE-03: staff invite a pre-screened prospect to apply from their own detail page; the lead applicant fills in their own section (name, DOB, current address, employer/income), uploads ID and income documents, adds co-applicants who each get their own link, and pays a per-applicant fee (Stripe-hosted fields, clamped to the jurisdiction cap) before their section counts as complete. New `Application`/`Applicant` models, `APPLICATION_LINK` auth-token purpose, a `prospect_application` notification category with three fixed templates (invite, co-applicant invite, fee-paid confirmation), two new `BillingProvider` methods for a one-off per-applicant fee, and public pages at `/apply/[token]`.

### `Application` is a thin group; `Applicant` carries every real fact

The PRD's own phrase - "co-applicants get their own links **and the applications group**" - is a grouping of independent people, not one record wearing several hats. `Application` holds only `propertyId`/`listingId`/`prospectId`/`completedAt`; every answer, every document, the fee itself, all live on `Applicant`, one row per adult. The fee is charged **per applicant**, not once per household - closer to how SFR actually runs application fees (and how screening itself runs, per person) than a single household charge would have been, and it sidesteps ever needing to split one payment across several cardholders. `Applicant.feeCents` is a **snapshot**, taken at invite time via `applicationFeeCentsFor()` (clamps `Listing.applicationFeeCents` to `JurisdictionRule.applicationFeeCapCents`, D-4/D-12) - a fee change on the listing after someone was invited must not move what they already agreed to owe, the identical reasoning a lease's own `Deposit.depositCents` already freezes at signing rather than tracking the listing forever.

### Completion is two fields, not one, because Stripe confirms asynchronously

`Applicant.formSubmittedAt` is set synchronously, the instant `submitApplicantForm`'s `validateApplicantForm` passes. `Applicant.completedAt` is set later - by the fee webhook if a fee was due, or immediately if none was - because collapsing the two into one field would have no honest value to hold while a validly-submitted form sits waiting on a payment still in flight. `Application.completedAt` (the PRD's "completion timestamp... which drives order-of-processing" for R-060) is the AND of every `Applicant.completedAt` under the group - a household is done only when everyone is.

### The fee is a Stripe webhook, and Stripe's own pipeline is invoice-shaped

`BillingProvider.createPaymentIntent`/`createCustomer` are hard-wired to an existing `leasePayerId`/`leaseId`, which an applicant has neither of - the interface's own header states the rule this follows: "each will widen this interface when it needs to... a wider one now would be method signatures guessed at ahead of their only caller." Widening meant **adding two sibling methods** (`createApplicationFeeCustomer`/`createApplicationFeePaymentIntent`), never loosening R-037's existing required fields under a caller that cannot supply them. The harder half was the inbound side: `apps/web/lib/billing/webhook.ts`'s whole pipeline is invoice-centric by design (D-11's ledger projection is scoped to tenancy money), and an application fee has no lease, no LeasePayer, and never becomes a `LedgerEntry`. Left as it was, the pipeline's own `LeasePayer` lookup would find nothing for an applicant's Stripe customer and silently record "ignored: no lease payer for customer X" - the one event that actually confirms a fee cleared, swallowed. `apps/web/lib/applications/fee-webhook.ts` is a small separate projector, checked **before** that lookup, that writes `Applicant.feePaidAt` and drives the two-field completion state above.

### `APPLICATION_LINK`: multi-use, and deliberately mid-length

A fourth multi-use-until-expiry token purpose (D-16's pattern, after `VENDOR_WORK_ORDER`/`TENANT_VERIFY`/`TENANT_PAY_LINK`) - a household gathering pay stubs and photo IDs across several sittings must not find the link dead partway through, which is what "progress is saved" means in the PRD text. Five days, a deliberate middle point rather than a copy of either neighbor: `TENANT_PAY_LINK`'s three days is short *because* it only shows a balance and takes a payment, `TENANT_VERIFY`'s seven is long *because* it moves no money and opens no document - `APPLICATION_LINK` does both at once (uploads documents AND can pay a fee), arguing shorter than seven, while a real household needs more than three days to coordinate. `applicationLinkStatus()` never rejects on an "already answered" business fact the way `prescreenLinkStatus()` does - the link stays fully live after completion, on purpose, since coming back to check fee status or add a document is the entire reason it is multi-use.

### Two real bugs, both caught only by e2e

A DB-integration test seeded a `Prospect` with `status: 'PRE_SCREENED'` set directly but never set `preScreenRespondedAt` - and the admin page's whole Application section (including the "Invite to apply" button) is gated on that field, not on `status`, so the section silently never rendered and every subsequent e2e step timed out waiting for a button that was never going to appear. A second race: the first version of the e2e spec clicked "Invite to apply" and immediately queried the database for the new `Applicant` row with no wait in between - the click event dispatches before the server action's own transaction commits, so the query sometimes ran first. Fixed by waiting on a visible UI consequence (`"Not invited to apply yet."` disappearing) before reading the database, the same pattern the OTHER test in this same spec already used correctly.

### What it left behind

- **No resend control for a stalled invite.** Same gap R-058 left for `sendPrescreenInvite`; nothing here calls `inviteToApply` a second time either.
- **No cross-application staff view.** Folded into the existing `/prospects` pipeline rather than a second list to keep in sync - `Prospect.status` is already the pipeline PM-04 reads, and an `Application` is the attached data for the APPLIED stage, not a competing source of truth.
- **Residence history is one current address, not a repeatable timeline.** The PRD says "residence history"; a multi-entry address history is a bigger form than this item's scope covers.
- **The fee payment UI is proved server-side only, never end-to-end.** `Elements` is a cross-origin iframe Playwright cannot drive without brittle same-origin assumptions - the identical limitation `AutopayPanel`'s own header already states, for the identical reason. `e2e/applications.spec.ts` proves the server half (the intent, the webhook, `completeApplicantIfDone`) by writing the fee-confirmed state directly and checking the staff page reads it correctly, not by driving a real card entry.
- **No duplicate-application detection.** A second `inviteToApply` for the same prospect is refused once an `Application` already exists, but nothing merges or flags a prospect who somehow ends up invited on two different listings.

---

## R-060 — SimulatedScreeningAdapter + written screening criteria
**Commit:** `88f8d67`  ·  **Date:** 2026-08-18

**What it built.** LEASE-04: a third `Adapter`/`SimulatedAdapter`/`provider` family (D-7, after syndication and billing) orders a per-applicant consumer report the moment a household's application completes - no separate staff click, no fake "continue to provider" redirect page, since no real vendor exists yet. `ScreeningCriteria` is a versioned config table (v1 seeded with placeholder income/credit/lookback defaults, `reviewedBy: null`), and `ScreeningReport` holds the provider's own facts plus a staff-only `decision`/`decisionNotes` pair. `evaluateCriteria()` (`packages/core/screening`) returns one MEETS/FAILS/UNKNOWN verdict per criterion - never a composite score - for the Prospect detail page's new Screening section to show alongside the criteria that produced it. `screening.decide` is a new privileged, MFA-gated permission; `recordScreeningDecision` enforces order-of-completed-application (`earlierUndecidedApplications`, pure) and requires an individualized-assessment note for anything but a plain approval.

**What it decided.**
- **OQ-6 answered by the owner: draft placeholder criteria now rather than block the item.** `07-decisions.md` updated - R-060 is built and shipped, but the seeded v1 numbers are explicitly unreviewed and must not be treated as a defensible policy until an owner/counsel review lands a new version.
- **Screening criteria are portfolio-wide, not scoped like `JurisdictionRule`.** D-4 scopes that table to statute, each field citation-backed; screening criteria are owner policy, and the fair-housing defense this table exists for depends on the SAME criteria applying to every applicant across the whole portfolio - a jurisdiction-by-jurisdiction patchwork would defeat the point.
- **Decision lives on `ScreeningReport` (per Applicant), not `Application` (per household).** FCRA consent and the report itself belong to one person - the same granularity R-059 already gave income, documents and the fee. R-061 (FCRA adverse action) reads these per-applicant rows to decide who gets a notice.
- **D-27 applied to a brand-new adapter family**: `SimulatedScreeningAdapter` derives credit score / eviction / criminal flags from a SHA-256 hash of the applicant id - never from `Applicant.monthlyIncomeCents` or anything else the criteria comparison also reads, so the simulator cannot agree with the evaluator by construction. Deterministic (not random) so a test can predict the exact facts via the exported `simulatedScreeningFacts()`, the same shape `billing/card-expiry.ts`'s simulated expiry already uses.
- **`screening.decide` added to `PRIVILEGED_PERMISSIONS`**, ahead of any permission existing to gate it - `packages/core/audit/events.ts`'s own header had already named "screening decision" among ROLE-03's privileged actions, and the audit action `screening.decided` was already sitting unused in the closed vocabulary from that same forward reference. Granted to `manager` alongside `lease.write`, not owner-only.

**What it left behind.**
- **No retry UI for a FAILED report.** `orderScreeningForApplicant` is idempotent and safe to call again, but nothing calls it a second time automatically or offers a staff button to.
- **No resend / re-order control at all** - same gap R-058/R-059 already left for their own invite flows.
- **The provider-hosted flow itself is not modeled as a redirect.** There is no real screening vendor chosen (D-7: Phase 3, partner-gated), so a fake "continue to provider" page would be theater with nothing behind it; ordering triggers automatically when the household's application completes instead. A real integration will need an actual redirect/return-URL flow, which is a different shape than this one.
- **`ScreeningCriteria` has no PM-facing editor** - versioned like `JurisdictionRule`, and seeded/edited the same way that table is (script, not UI). A staff-facing criteria editor is a follow-up if the owner wants to change the numbers without a deploy.
- **The e2e spec discovered that React resets an uncontrolled form after every action call, success or failure** - a decision select goes back to its placeholder along with everything else on a validation error, the same reason every other multi-field form in this codebase that can fail validation is a single round trip rather than a fix-one-field retry. Not a regression, but worth naming: a user who mistypes hits a full re-fill, not just the one field.

---

## R-061 — FCRA adverse action
**Commit:** `0467a35`  ·  **Date:** 2026-08-18

**What it built.** LEASE-05: the moment `recordScreeningDecision` (R-060) writes a DECLINED or APPROVED_WITH_CONDITIONS decision, the same transaction generates an FCRA adverse-action `Notice` (CRA name/address/phone, the "did not make the decision" disclosure, the free-report and dispute rights, the specific FAILS criteria and the staff member's own individualized-assessment note) and - when the applicant has an email and a current address on file - auto-serves it by email in the same request, the way an entry notice already auto-serves to the portal. The pipeline's SCREENED→APPROVED auto-advance now also checks that no applicant still owes an unsent notice; `advanceProspectStage`'s manual move to APPROVED/SIGNED gets the identical check, warns, and accepts a logged override reason when staff need to go ahead anyway (mirrors `scheduleEntry`'s own warn-and-override for entry notices).

**What it decided.**
- **D-51: the notice rides Notice/NoticeDelivery, not Notification.** `Notice.leaseId` is now nullable and `Notice.applicantId` was added, with a CHECK constraint enforcing exactly one of the two - an adverse-action notice gets the same append-only-by-trigger delivery log, the same `/notices` register, and the same PDF archiving every other legal notice already uses, rather than living in the routine-messaging system. Full reasoning and the rejected alternative are in `07-decisions.md`.
- **The reporting agency's identity is frozen at order time, as rendered text, not structured columns.** `ScreeningAdapter.order()` now returns an `agency` object; `ScreeningReport.agencyContact` stores it pre-formatted, because nothing ever queries agency name or address independently - it exists only to be reproduced verbatim in the notice, § 1681m(a)(1)'s requirement.
- **"Blocks closing the application" landed on the two places a household actually advances past SCREENED**, since there is no separate "close" concept yet (R-063 hasn't shipped): the automatic SCREENED→APPROVED transition, and the manual `advanceProspectStage` move to APPROVED/SIGNED. R-063 (lease generation) inherits both gates already in place when it ships.
- **The override is its own audit action, `adverse_action.overridden`, in `REASON_REQUIRED`** - the same call R-055 already made for `entry_notice.overridden`: that set enforces "always required" per action, and cannot express "required only when a notice is owed", so a plain flag on `prospect.stage_changed` would not have been enforceable at the writer.
- **No AI or algorithmic applicant scoring anywhere in this path, restated for the one document that could smuggle it back in.** `adverseActionNoticeText()` reproduces `evaluateCriteria()`'s own plain-language FAILS statements and the staff member's decision notes - it never computes a score, a ranking, or a recommendation.

**What it left behind.**
- **No retry or resend for a notice that failed to auto-serve** (no email on file, or the send itself failed) - staff use the existing `/notices/[id]` "Record service" form (now applicant-aware) to log a mailed or hand-delivered service instead, or the override escape hatch if they choose to proceed without one.
- **e2e test cleanup discovered a real invariant, not a bug**: `NoticeDelivery` is append-only by trigger and `Notice.applicantId` is RESTRICT, so once a spec creates an auto-served adverse-action notice, the Applicant/Application/Prospect/ScreeningReport chain beneath it cannot be hard-deleted in `afterAll` - the same "retire, don't delete" rule CLAUDE.md already states for any row an append-only table references. `e2e/screening.spec.ts`'s cleanup now only deactivates Property/LegalEntity/StaffUser and leaves the rest, the same as any other evidence-shaped row this product refuses to erase.
- **No document-level DOCUMENT_TYPES entry was needed** - the adverse-action PDF reuses the existing `NOTICE` document type, the same one every other notice's archived PDF already uses.

---

## R-062 — Document generation service
**Commit:** `58fa5a1`  ·  **Date:** 2026-08-18

**What it built.** DOC-04/§6.4, in two genuinely separate halves.

*Accessibility tagging*, retroactively on all three existing PDF producers (notices, comms transcripts, ledger statements), since they all share `apps/web/lib/pdf/render.ts`'s `renderBlocksPdf()`: every generated PDF now sets `/Lang` (default `en-US`, overridable), carries a real `/StructTreeRoot` with `/MarkInfo Marked=true`, and tags every block `/H1`/`/H2`/`/P` via `BDC`/`EMC` marked-content operators with an `/MCID`, in draw order (which is already reading order - nothing here reflows text). `/Title` already existed from R-051.

*A PM-authored, merge-field document template system* (`DocumentTemplate`) - the `MessageTemplate` shape (R-049) applied to a generated PDF instead of an email/SMS body, for the genuinely PM-authorable case DOC-04 names directly ("notices, letters, estoppel certificates"): `LETTER` and `ESTOPPEL_CERTIFICATE` are new `DocumentTypeValue`s. Staff author a template with `{{merge.fields}}` at `/documents/templates`, generate a PDF per recipient from a template's own detail page (property + recipient name are the two facts a reused template cannot supply on its own), and the result archives as a `Document`, audited.

**What it decided.**
- **`mono` blocks (the "table" in a ledger statement) are tagged `/P`, not `/Table`/`/TR`/`/TH`/`/TD`** - written down as a real, deliberate gap rather than silently skipped. The content is space-padded Courier text with no actual cell boundaries (`blocks.ts`'s own header explains why no column model exists); asserting `/Table` structure over content that has none would be a WORSE accessibility artifact than an honest `/P` - a screen reader told "this is a table" then finding run-on padded text with nothing to navigate cell-by-cell.
- **No `/ParentTree`.** That number tree exists for looking a marked-content run back up to its `StructElem` (used by "read this selection", not the linear announce-the-document flow every screen reader uses first) - real, fiddly, untested surface for a lookup direction nothing in this product needs yet. Marked `ponytail:` in the code.
- **A block that itself crosses a page break becomes two sibling `StructElem`s of the same role**, not one element spanning two pages via multiple `/K` entries - the fully general PDF/UA shape needs the `/ParentTree` this build deliberately omitted. Reading order across the resulting siblings is still exactly right; only "this was logically one paragraph" is lost.
- **Reused `packages/core/comms/merge-fields.ts`'s `renderTemplate()`/`mergeFieldsUsed()` verbatim** rather than writing a second engine - `renderTemplate()` needed no changes at all (it takes a values map, no catalogue), and only the CLOSED CATALOGUE a template's tokens are checked against (`DOCUMENT_MERGE_FIELDS`, in `packages/core/documents/template.ts`) is document-specific, for the same reason messages and documents already needed separate catalogues: different closed lists, same two rules (no internal identifiers, nothing requiring a computation).
- **DocumentTemplate is deliberately NOT for notices, leases, receipts or dispositions.** Each of those either already has (entry, chargeback, adverse-action notices) or will have (R-063 lease generation, R-071 disposition) its own typed generator, driven by business logic a PM cannot safely hand-edit - jurisdiction rules, computed amounts, statute citations. `DOCUMENT_MERGE_FIELDS`' catalogue has no field that could carry one of those numbers, on purpose.
- **Every merge field this build's one real template context supplies is currently guaranteed non-null** (property name/address, owning entity name, today, staff name are all `NOT NULL` columns; recipient name is form-required) - so `renderTemplate()`'s "fails loudly, refuses to generate" path, while real code with real unit-test coverage (`packages/core/documents/template.test.ts`, reusing the exact mechanism `announcement-actions.ts`/`payments/reminders.ts` already trust), has no reachable trigger through today's one generate flow. A future template referencing something genuinely optional (a lease's own field, once R-063 widens the catalogue) is where this actually fires for real.

**What it left behind.**
- **No live preview before generating** - `comms/template-editor.tsx`'s live render-as-you-type is COMM-03's own acceptance criterion for messages; nothing in DOC-04 asked for the equivalent here, and building it would have been speculative infrastructure for a feature nobody requested yet.
- **No translations.** A generated letter is English-only; COMM-03's approved-translation machinery is message-specific and was not extended here.
- **Receipts and dispositions are still unbuilt.** `payment.receipt` remains an email/SMS-only notification (no archived PDF); R-071 (deposit disposition) hasn't shipped and isn't gated on this item per the backlog's own dependency graph, despite R-062's row naming both as eventual consumers.
- **Two real e2e bugs found and fixed while proving this, both instances of lessons this build has hit before**: React resets EVERY uncontrolled field after a form action completes, not just the one under test (the same trap R-060/R-061 already named) - the template-save spec's second submission was silently failing validation on the reset `name`/`documentType` fields until both were refilled. And a bare `getByLabel('Property')` substring-matched the admin shell's own "Filter by property or entity" combobox - fixed to `'Property *'` exact, `tasks.spec.ts`'s own existing precedent for the identical collision.

---

## R-063 — Lease generation + SimulatedESignAdapter
**Commit:** `7d3f98f`  ·  **Date:** 2026-08-18

**What it built.** LEASE-06/DOC-02, the last of D-7's three named simulated adapters: `generateAndSendLease` (a staff action, privileged `lease.execute`) resolves a per-state `DocumentTemplate` (new `state`/`addendumKey` columns, R-062's model reused rather than a parallel one), picks applicable addenda via a pure `applicableAddenda()` (six triggers - lead paint from `Property.yearBuilt`, HOA from an existing `HoaInfo` row, and four new property facts: `hasPool`, `hasWellOrSeptic`, `moldHistoryNotes`, `bedbugHistoryNotes`), renders every merge field through a lease-specific catalogue (`LEASE_MERGE_FIELDS`, reusing `comms/merge-fields.ts`'s engine exactly as R-062's document catalogue does), and archives an unsigned draft PDF. `SimulatedEsignAdapter` (mirroring `SimulatedScreeningAdapter`'s three-file shape and D-27's "holds no state of its own" discipline) mints envelope/signer ids; each signer gets their own token-gated `/sign/[token]` page (a new multi-use `LEASE_SIGN` `AuthToken` purpose, D-16) to review the document and type-and-check an electronic signature. Once every signer has signed, the executed PDF is built by `appendPdfs()`-ing a freshly rendered Certificate of Completion onto the ORIGINAL draft bytes (never re-rendering the lease body), the lease activates through the same `activateLeaseSideEffects()` the staff-driven path uses, `provisionLeaseBilling()` opens the Stripe subscription (R-034/036, unchanged), and a new `chargeDeposit()` (modeled directly on R-042's `chargeMoveInProration`) posts the security-deposit `Charge` - the backlog's own words, "the rent schedule and deposit charge create themselves."

**What it decided.**
- **D-52 (OQ-7 answered): ships a placeholder lease template rather than blocking, the same call OQ-6 made for R-060.** Installed by a standalone, manually-run script (`db:seed:lease-templates`) rather than `seed.mts`, because `DocumentTemplate.createdByStaffId` is required and a fresh database has no StaffUser yet - see D-52 in `07-decisions.md` for the full reasoning and the two alternatives rejected.
- **R-063 begins at "given a complete DRAFT lease" - it does not build an Application-to-Lease bridge.** R-033's existing `createLease`/`addLeaseTenant`/`addGuarantor` are unchanged and are how a lease gets its people before generation; auto-creating Tenant rows from Applicant rows and linking a lease back to its originating Application/Prospect is real, separate scope the backlog row's own text never asked for, left for whoever wants that UX polish.
- **`LeaseEnvelope.leaseId` is deliberately NOT unique.** A voided envelope is kept as evidence rather than replaced in place (the same "retire, don't delete" rule the append-only tables follow), so a lease can accumulate more than one envelope row over its life; "at most one non-voided at a time" is enforced in the staff action, not a DB constraint - the same app-layer posture most business invariants here already take (the DB enforces only the four append-only tables, by trigger).
- **The utility-responsibility matrix is a structural block, never a merge field.** LEASE-06 asks for a "matrix"; `LEASE_MERGE_FIELDS` deliberately has no token for it, and `leaseDocumentBlocks()` appends it as its own table section instead - the same call R-052's ledger statement made for tabular data no `{{token}}` could represent honestly.
- **Every status write still routes through `leaseTransition()`, including the two new callers.** `generateAndSendLease` calls it for DRAFT → PENDING_SIGNATURE and the esign completion path calls it again for PENDING_SIGNATURE → ACTIVE, rather than writing `status` directly - `changeLeaseStatus`'s own header rule, extended to a system-triggered writer for the first time. The generic "Make this lease active" button is hidden (and the action itself now refuses) while a live envelope is out, so the only way to short-circuit signing is to void the envelope first, on the record with a reason (`envelope.voided`, `REASON_REQUIRED`).
- **The executed PDF is the draft's own bytes plus an appended certificate, never a re-render.** `appendPdfs()` (D-50's own precedent, built for attaching Stripe's invoice PDFs to a statement) copies a freshly rendered Certificate of Completion onto the exact PDF every signer reviewed - so a lease term edited after sending (nothing currently blocks that at the row level) cannot silently change what the executed document shows.
- **`lease.execute` is privileged (MFA-gated), granted to owner and manager alongside `lease.write`/`screening.decide`** - the same bar R-060 set: this action makes a legally binding document and, on completion, moves money.
- **A guarantor signer has no dedicated `AuditActor` type.** The closed union is `STAFF | TENANT | VENDOR | SYSTEM`; a guarantor's own signature is recorded as `SYSTEM` with a `ref` naming the guarantor plainly, rather than extending the union for one narrow, low-traffic role - left as a named gap rather than a silent one.

**A real, unrelated bug found and NOT fixed here, named instead.** `chargeMoveInProration` (R-042) calls `auditAsSystem` with action `ledger.adjusted`, which is in `REASON_REQUIRED` - with no `reason` or `reasonCode`, so `recordAudit` throws `MissingAuditReasonError` on every call, silently caught by the function's own `.catch()`. Every part-month proration charge today writes its `Charge` row correctly but has never once written its audit entry. `chargeDeposit` (this item) copies the same shape but passes `reasonCode: 'other'` so it does not repeat the bug; `chargeMoveInProration` itself was left untouched - fixing it is a one-line, unrelated change outside this item's scope.

**A real product bug found and fixed while proving the browser flow.** A Server Action submitted from a `<form>` always triggers a refresh of the Server Component tree once it completes, which re-evaluates `/sign/[token]`'s own `link.status === 'SIGNED'` branch and unmounts `SignForm` - taking its local `useActionState` success notice ("Signed. Thank you.") down with it before a human or Playwright can see it painted. Fixed by making the post-refresh "already signed" branch itself carry the confirmation, worded differently depending on `envelopeStatus` (still waiting on other signers, vs. every signer done and the lease active) - the only message a signer who just submitted actually sees.

**What it left behind.**
- **No Application-to-Lease bridge** (see above) - a lease is still created and peopled the way R-033 already built.
- **No resend/retry UI.** A `DRAFT` (generated-but-unsent) envelope is reused automatically if `generateAndSendLease` is called again after a provider failure, but there is no separate "resend the link" control for a signer who lost their email - the same gap R-058/R-059/R-060 already left for their own invite flows.
- **`Deposit` (the liability row) is not created here, only the `Charge` demanding it.** `Deposit.heldCents` means funds actually held; that becomes true once a payment clears, which is R-069's "door codes withheld until move-in funds show cleared" - out of this item's dependency chain on purpose.
- **No hard sequential signer-order enforcement.** Every signer's link is live the moment the envelope is sent; `order` is recorded and displayed but the first signer is not required to go before the second, matching how real parallel-capable embedded providers behave.
- **A check-then-act race on envelope completion**, marked `ponytail:` in `esign-actions.ts`: two signers completing within the same instant could both observe zero remaining and both attempt completion; the `status === 'COMPLETED'` guard stops a second executed document from being written but is not a row lock. Accepted for a lease with at most a handful of signers; a `SELECT ... FOR UPDATE` on the envelope row is the upgrade if real concurrent last-signers ever show up.
- **The new migrations are applied to the local test database only.** `db:migrate:dev`/`db:migrate:all` (which reach the shared Neon dev branch) were deliberately not run as part of this item - that stays a separate, visible step for whoever deploys next, per this repo's own "migrations no longer reach the cloud dev branch as a side effect" rule.

---

## R-064 — Showings
**Commit:** `7d6d410`  ·  **Date:** 2026-08-19

**What it built.** LEASE-08's non-lockbox half: answering pre-screening (R-058) now auto-sends a prospect a single-use `SHOWING_BOOKING` link; `/showings/[token]` shows every open slot on a fixed 9am-6pm/30-minute grid (`availableShowingSlots()`, `packages/core/scheduling/showings.ts`) and lets them book one with no account. Booking an occupied unit's slot generates and serves the required tenant entry notice inline, reusing R-027's own `entryDecision()`/`entryNoticeText()` machinery - the same decision a work order's `scheduleEntry()` makes, applied here with no warn-and-override path, since a self-serve form has nobody present to give an override reason: a slot that fails the check is simply refused rather than booked-and-flagged, and the offered slot list already excludes anything short of `earliestCompliantStart()` in the first place. Every booking - vacant or occupied - raises an `escort_showing` `Task` (D-9), because R-064 ships no unaccompanied-entry mechanism; that is R-094 (Phase 3), not this item. `sweepShowingReminders()` sends the prospect a T-1-day and T-2-hour SMS/email reminder off the hourly cron tick, same elapsed-time-sweep shape as R-027's own `sweepEntryReminders()`. Staff see the booked (or cancelled) showing on the prospect's own detail page, with a `cancelShowing` action that also cancels the escort task rather than leaving it open against a visit that is not happening.

**What it decided.**
- **D-53: every showing is staff-escorted, on one fixed slot grid shared by every property.** Full reasoning in `07-decisions.md`, including the correction to this backlog row's own text - it named the deferred lockbox item as R-087 (an unrelated item), when the real one is R-094.
- **`Showing.entryNoticeId` is set if and only if the unit was OCCUPIED at booking time** - the same single-column "which basis, and against what" shape `WorkOrder.entryNoticeId` already gives a work order's own entry compliance, reused rather than re-invented.
- **`Showing` has only `BOOKED`/`CANCELED`, no `NO_SHOW`/`COMPLETED`.** Nothing downstream reads a showing's outcome yet - unlike `WorkOrder.tenantNoShowAt`, which R-030's chargeback flow actually consumes - so a richer status would be a flag no check reads. `CANCELED` exists because a stale `BOOKED` row would keep blocking its own slot and leave its escort task open forever; that is the one status transition something (the next booking, the escort queue) genuinely needs.
- **The showing invite fires automatically at the end of `submitPrescreenAnswers`**, best-effort like `sendPrescreenInvite`'s own call site - keeping the whole inquiry-to-booking chain self-serve end to end (LEASE-08's own framing), with no staff action required in between unless a booking needs to be cancelled.
- **Reused `entry_notice`/`entry.notice` for the tenant-facing side, a new `prospect_showing` category/`showing.invite`/`showing.scheduled` templates for the prospect-facing side.** The tenant message IS an entry notice regardless of what triggered it; the prospect never has an account, so it gets the same "no preferences to read" category shape `prospect_prescreening`/`prospect_application` already established.

**What it left behind.**
- **No per-property showing-hours configuration.** `DEFAULT_SHOWING_WINDOW` is a shared constant because no business-hours concept exists anywhere in this codebase to read instead; `availableShowingSlots()` already takes an override, so this is a config field away when a real owner asks for different hours.
- **No reschedule control.** `SHOWING_BOOKING` is single-use like `PROSPECT_PRESCREEN` (booking one slot is the one action it guards) - a prospect who wants to change their time needs a fresh invite, and there is no staff-facing resend button yet, the same gap R-058/R-059/R-060/R-063 have each left for their own invite flows.
- **No property-wide showings calendar.** A booked (or cancelled) showing is visible on its own prospect's detail page only; a cross-property "who's showing what today" view is a `/showings` list screen nobody has asked for yet.
- **A check-then-act race on the vacant-unit slot grid, same shape as R-063's envelope-completion race**: two prospects submitting the same open slot within the same instant could both pass the `slots.some(...)` re-check before either write lands. Accepted at the scale this ships at (a handful of showings per unit); a unique index on `(unitId, scheduledStart)` for live `BOOKED` rows is the upgrade if double-booking is ever actually observed.
- **`cancelShowing` requires no reason.** Unlike an entry-notice override or a voided lease envelope, a cancelled showing is not something a later dispute turns on, so this stayed the plain `task.canceled` shape rather than a `REASON_REQUIRED` action.

---

## R-065 — Renewals
**Commit:** `81e6831`  ·  **Date:** 2026-08-19

**What it built.** LEASE-09 end to end: a daily job (`renewal-window-job.ts`) flags a fixed-term lease once inside its 120/90-day window, raising a `lease_renewal` Task (D-9) exactly once per lease rather than once per day it stays open. From the lease's own detail page, a PM offers a renewal (`offerRenewal`) — current rent shown against the unit's market rent, a new term and proposed rent typed in — which runs the new rent-increase guard (`packages/core/leases/renewal.ts`) against the property's `JurisdictionRule`: a statutory cap (`rentIncreaseCapPercentBps`, new column) blocks outright, a notice-period shortfall (`rentIncreaseNoticeDays`, already existed) warns and requires a stated reason (`lease.renewal_rent_check_overridden`, `REASON_REQUIRED`). A clean offer creates a DRAFT successor `Lease` (`origin: RENEWAL`, `renewedFromLeaseId` pointing back) with the current tenants copied over, and hands off to R-063's existing `generateAndSendLease`/e-sign machinery completely unmodified — the PM sends it and the tenant signs exactly as they would a brand-new lease. `esign-actions.ts`'s completion path is now renewal-aware: a fully-signed renewal successor whose effective date has not yet arrived stays PENDING_SIGNATURE (no deposit re-charge, no early billing) rather than activating on signature the way an ordinary lease does; a new daily job (`renewal-cutover-job.ts`) activates it and ends the predecessor in one transaction on the effective date, cancelling the predecessor's own Stripe subscription. A separate daily job (`renewal-rollover-job.ts`) is the fully-automatic path LEASE-09 also asks for: a fixed term that runs out with no renewal in flight rolls the SAME lease to MONTH_TO_MONTH at its already-existing `mtmRentCents`, no e-sign, no new row. A new dashboard tile and `renewalRateSummary()` track the outcome portfolio-wide.

**What it decided.** Recorded as **D-54**; the load-bearing parts:
- **A renewal is always a new Lease row, and it never activates at signature time.** `packages/core/leases/status.ts`'s own header already required the first half ("agreeing a new fixed term is a new lease") before this item touched the file. The second half — waiting for the effective date rather than activating the moment every signer signs, the way R-063's `completeEnvelope` already does for an ordinary lease — is what this item actually had to build, and it is not a nicety: a renewal is routinely signed weeks ahead of its own start (the statutory notice period is the whole reason), and activating early would open a second live Stripe subscription on the same unit while the predecessor's is still billing. That is real double-billing, not a theoretical one, found by tracing what `provisionLeaseBilling`/`chargeDeposit` actually do before writing a line of the cutover job, not discovered by a test afterward.
- **A statutory cap blocks; a notice-period shortfall warns.** Two different postures for two different kinds of rule, the same split R-027's entry-notice guard already draws between an emergency override and a hard limit: nothing makes an illegal rent increase legal, so a cap violation has no override field at all, while a short-notice offer can still be the right call with a documented reason.
- **Ending the predecessor on cutover is deliberately NOT `changeLeaseStatus`.** That function also flips the unit to MAKE_READY on the way off a lease going out of force — correct for an ordinary move-out, wrong here since the tenant is continuing in the same unit. The cutover job writes the predecessor's `ENDED` status directly and leaves `moveOutAt` null.
- **MTM rollover counts as "renewed" for the metric, whatever put a lease there.** `renewalRateSummary()` does not distinguish a lease that started on MTM terms from one this item's own job rolled over — both are a continuing tenancy, which is what the number is actually asking about.
- **The 120/90-day flag and the offer form are deliberately decoupled.** The flag Task exists so a PM's queue surfaces the window opening; the offer form itself is available on any running lease with no successor already in flight, whether or not that Task happens to still be open — the same posture `changeLeaseStatus`'s own buttons take (available whenever the move is legal, never gated behind an unrelated artifact).

**What it left behind.**
- **The security deposit does not follow a renewal.** `Deposit.leaseId` still points at the predecessor after a cutover — correct in that no money moves on a renewal, but a later reader asking "what deposit does this tenancy hold" has to walk `renewedFromLeaseId` backward rather than reading it off the current lease. Named in D-54 rather than solved speculatively here.
- **Guarantors are not copied to a renewal successor.** Only `LeaseTenant` rows carry over; a lease with a guarantor needs one re-added by hand via the existing `addGuarantor` action.
- **No resend control for a stalled renewal offer** — the same gap every other invite-shaped flow in this codebase (R-058/R-059/R-060/R-063/R-064) has already left for its own first version.
- **The renewal-rate metric is a structural snapshot, not a trailing-window rate.** It answers "of every original tenancy that has concluded, how many continued" as of right now, not "renewal rate over the last 12 months" — the latter would need a real event timestamp this build did not add.

**Bugs found along the way.**
- **A test-authored one, not a product one, but the exact trap CLAUDE.md already names for a different spec**: the e2e's `waitForURL` regex excluded `/leases/new` but not the PAGE IT STARTED ON — since the test navigates to `/leases/<predecessor-id>` before submitting the offer, that URL already satisfies a bare `/leases/<id>` pattern, so the wait resolved instantly against the predecessor's own page before the real redirect to the successor happened. Fixed by excluding the specific starting lease id, not just the literal string "new".

---

## R-067 — Renter's insurance tracking
**Commit:** `8219916`  ·  **Date:** 2026-08-19

**What it built.** LEASE-10 end to end: a new lease-scoped `RenterInsurancePolicy` model (carrier, policy number, liability coverage, expiry, an optional linked certificate `Document`), recorded from the lease detail page's new "Renter's insurance" section (`recordRenterInsurance`) — the certificate file is genuinely optional, since carrier/dates read off a phone call are a real, useful state before the PDF arrives. A new daily job (`renter-insurance-job.ts`) flags a lease's current policy once it is within 60 days of expiring (`ROUTINE`) or once it has lapsed (`URGENT`), the same 120/90-day-flag shape R-065's `renewal-window-job.ts` just established, reusing `businessDaysBetween` rather than hand-rolling a second date-diff. Recording a fresh policy auto-closes whichever alert Task it supersedes.

**What it decided.** Recorded as **D-55**:
- **A new row every time, never an update.** `RenterInsurancePolicy.leaseId` is deliberately not unique — an annual renewal is a new certificate with its own expiry, and overwriting the old row in place would erase the record of what was on file when it lapsed. The most recent row is read as "the current policy" everywhere (the panel, the alert job).
- **A third, deliberately distinct document type.** `RENTER_INSURANCE_COI` is not `INSURANCE_COI` (a vendor's own proof of coverage, R-025) or `INSURANCE_DECLARATION` (the property owner's own policy, R-015) — three different entities insuring three different interests that happen to share an English word, each already carrying a comment saying so.
- **A lease with no policy on file at all is not flagged.** LEASE-10 tracks the expiry/lapse of a certificate that exists; nothing in this product's data model says a given lease *requires* one (no `insuranceRequired` toggle anywhere), so inventing a "missing entirely" alert would enforce a rule the product was never told exists — the identical trap D-4 already names for an unconfigured jurisdiction number.

**What it left behind.**
- **No "insurance required" toggle, and no alert for a lease that has never had a policy recorded.** Named in D-55 as the real follow-on if an owner ever wants to *require* coverage rather than only track it once provided.
- **No tenant-facing reminder to renew.** LEASE-10's own story is framed entirely from the PM side ("As a PM, I can require and track"); the alert is a staff Task, not a tenant notification.
- **No resend/upload-later flow beyond the plain "record a new policy" form** — a PM re-uploading a renewed certificate just records a new row, same posture every other invite/document flow in this codebase has already settled for its own first version.

---

## R-066 — Notice to vacate + non-renewal
**Commit:** `3684713`  ·  **Date:** 2026-08-19

**What it built.** LEASE-11 end to end, both directions of "notice to end the tenancy": a tenant's own self-serve intake (`/portal/papers/notice`, D-10's plain "Give notice to vacate") records date + forwarding address as an inbound fact, no override needed; an owner's non-renewal, recorded from the existing `recordLeaseNotice` staff form, now generates and serves a real `Notice` (type `NON_RENEWAL`) with `NoticeDelivery` and a tenant notification, reusing R-027's own `entryDecision`-style machinery rather than building a parallel one. Both directions run the SAME `noticePeriodCheck()` against `JurisdictionRule.noticeToVacateDays` (present on the schema, unused until now) — warn-and-override on the staff side, purely informational on the tenant's own submission. RISK-06's retaliation guard, already wired into `recordLeaseNotice`'s LANDLORD branch by R-055, now fires alongside the notice-period check rather than instead of it — both warnings surface together in one round trip. A jurisdiction with `justCauseRequired` set (also present, unused until now) makes a stated cause a plain required field on a LANDLORD notice, embedded verbatim in the served notice's body — never a canned list of legally-qualifying reasons this product would be picking on the owner's behalf.

**What it decided.** Recorded as **D-56**:
- **One notice-period number serves both directions.** No jurisdiction has ever been asked to distinguish "how much notice must a tenant give" from "how much notice must an owner give before non-renewing" — `noticeToVacateDays` is read symmetrically rather than inventing a second config field for a split nobody has configured.
- **The tenant's own portal submission gets no override round trip for a short notice period**, deliberately unlike the staff side — a tenant is not defending a business decision a later dispute could turn on, so a shortfall is stated as a plain consequence (rent may still be owed through the required period), not demanded as a justification.
- **Two `Lease` columns, `noticeEffectiveOn` and `noticeForwardingAddress`, sit beside the existing `noticeGivenAt`/`noticeGivenBy`** — still a fact about a running lease, never folded into `LeaseStatus` (that model's own comment on why holds unchanged).
- **A real collision found and fixed**: R-065's `renewal-rollover-job.ts` would have silently auto-rolled a lease under notice — landlord non-renewal or tenant's own notice to vacate alike — to MONTH_TO_MONTH the very next night, since its candidate query never checked `noticeGivenAt` at all. Fixed with one added clause, covered by a new test case.

Full reasoning, and the rejected alternatives (per-party notice-period fields, a canned just-cause list), are in `07-decisions.md`.

**What it left behind.**
- **No enforcement that a non-renewal actually reaches the unit's turnover pipeline.** Serving the notice and blocking the auto-MTM-rollover are as far as this item goes; what happens operationally as the move-out date approaches (R-070/R-072's territory) is unconnected to this beyond the dates now sitting on the lease.
- **No staff-facing resend for the tenant notification**, same gap every invite-shaped flow in this codebase (R-058/R-059/R-060/R-063/R-064) has already left for its own first version.
- **The tenant's own notice-to-vacate form has no "change my mind" / withdraw control.** `canGiveNotice()` refuses a second notice on the same lease outright; correcting a mistaken date today means a staff member editing the record directly, not a tenant-facing undo.

---

## R-068 — Inspection engine (phase 1 of 2)
**Commit:** `3218bda`  ·  **Date:** 2026-08-19

**What it built.** The reusable checklist engine INSP-01 asks for, minus photos and e-sign - a deliberate split for an L item, agreed with a concurrent session on this same repo before starting (the backlog row's own note names exactly what phase 2 still owes). `InspectionTemplate` (a portfolio-wide, PM-authored room/item checklist - one JSON column, not a child table, since nothing ever queries into a single template item on its own) is copied wholesale into fresh `InspectionItem` rows the moment a PM starts an inspection, independent of the template from that point on. The full lifecycle is a derived status, not a stored one: `inspectionStatus()` reads `scheduledFor`/`performedAt`/`tenantSignedAt`/`lockedAt` in order (DRAFT → SCHEDULED → IN_PROGRESS → PENDING_SIGNATURE → SIGNED → LOCKED), the same "facts, not a status column" call `LeaseStatus` already made. A staff member walks every item (condition + notes), finishes the walk once every item is recorded, records that a tenant signed (in person, on the inspector's own phone - no tenant-portal e-sign yet), and locks the report - `canEditItem()` refuses every further item write once locked, proved end to end in `e2e/inspections.spec.ts`.

**What it decided.** Recorded as **D-57**:
- **A portfolio-wide template, not per-property.** The same checklist has to be walked at move-in and move-out for R-070's own side-by-side comparison to mean anything - scoping a template to one property would work against the feature that depends on it staying identical.
- **No status column - four facts and one pure function that reads them**, matching `Lease.noticeGivenAt`'s own precedent rather than adding a fifth thing that could drift from what actually happened.
- **A real e2e failure changed the UI shape**: a client-side "Add item"/"Remove" button for building a checklist hit CLAUDE.md's own documented trap - `onClick` is inert until hydration, and a Playwright click (the same as a real person tapping fast on a slow connection) landing before that moment was a silent no-op that left the test hanging on a row that never appeared. Replaced with a fixed 8 blank row slots, needing no client JS to work at all - the same progressive-enhancement posture every `<form action>` in this codebase already gets for free.
- **Two pre-existing test-isolation flakes found while verifying the gate, confirmed unrelated to this item by rerunning each in isolation**: a `JurisdictionRule` race on state `'ZZ'` between several test files, and a global `AuthToken` count assertion in `vendors/reissue.test.ts` that can shift under full-suite parallel execution. Not fixed - out of this item's scope - but named here so a future session does not re-diagnose them from nothing.

Full reasoning in `07-decisions.md`.

**What it left behind — explicitly PHASE 2, not a silent gap:**
- **No photo capture on an item, no EXIF timestamp, no geotag.** INSP-01's own line ("per-item condition, notes, photos (timestamped, geotagged)") is half-built - the schema has no `Document` linkage to an `InspectionItem` yet either, deliberately deferred alongside the UI that would use it.
- **No tenant-portal e-sign.** `recordSignature` is staff-only ("recorded that a tenant signed on the inspector's own phone"); `canRecordSignature`'s own comment names this as the interim posture, not the destination.
- **No auto-finalize-after-a-window job.** INSP-01 asks for a report to auto-finalize if nobody signs within a stated window; today a report simply waits, un-locked, until a staff member locks it by hand.
- **No R-069/R-070-specific wiring yet** (door codes withheld until funds clear, the side-by-side move-in/move-out comparison via `moveInItemId`) - this item builds the engine those items drive, not their own logic.

---

## R-068 — Inspection engine (phase 2 of 2)
**Commit:** `9e94a70`  ·  **Date:** 2026-08-19

**What it built.** The three pieces phase 1 named and deliberately deferred. Photo capture: `Document.inspectionItemId` (a new, real FK - "the checklist row it is evidence for," matching `workOrderId`'s own directness) plus new `latitude`/`longitude` columns, generic on `Document` since EXIF GPS is a property of the file itself, not of being an inspection photo specifically. `extractGeotag()` sits beside the existing `extractCapturedAt()` in `documents/exif.ts`, using the same lite `exifr` build's own `.gps()` helper (tested against a real, hand-encoded GPS EXIF block, the same "against the real library" posture that file's own header already argued for `capturedAt`). A tenant's own e-sign: `signInspectionAsTenant` (portal-side, session-based) signs AND locks in one transaction - unlike the staff path, which stays two separate steps from phase 1. An auto-finalize job (`auto-finalize-job.ts`) locks a performed-but-unsigned report after 3 days and notifies the tenant either way (`inspection.signature_needed` when the walk finishes, `inspection.auto_finalized` if nobody signed in time) via a new `inspection_signature` notification category.

**What it decided.** Recorded as **D-58**:
- **Every inspection photo also gets `Document.leaseId` set from the inspection's own lease** - not a new visibility rule, just feeding the EXISTING tenant-portal document rule (`tenantCanSeeDocument`, DOC-03) the fact it already knows how to use.
- **A tenant's portal signature locks the report in the same step; a staff-recorded one still does not.** Deliberate, not inconsistent: a tenant signing from the portal has already done their own review by definition (the page IS the review), where a staff member recording someone else's in-person signature reasonably keeps a checkpoint before finalizing. Both write the identical `inspection.signed` audit action, told apart by `actorType`.
- **Rejected a public `/inspections/sign/[token]` magic-link page**, the shape R-063 uses for a brand-new lease signer. That page exists because a new tenant has no portal account yet; an inspection happens during an active tenancy, so the tenant already has one - a second, parallel public-token surface would just duplicate `requireTenantWithScope()` for no reason.
- **3 days, a literal constant** for the auto-finalize window - no `JurisdictionRule` concept exists for this, and every sibling job in this codebase (`renter-insurance-job.ts`, `renewal-window-job.ts`) already makes the identical call for its own day-count rather than inventing config nobody asked to vary.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **No manual reordering or removal of a checklist template's items beyond the fixed-rows form** - a PM builds or edits a checklist by filling/clearing rows, not by dragging or renumbering. Fine for a room-by-room list that rarely changes mid-life.
- **No photo deletion or replacement from the inspection UI** - `Document`'s own soft-delete (DOC-05) exists but nothing here calls it; a wrong photo today means adding a correct one alongside it, not removing the mistake.
- **The auto-finalize job notifies the tenant, not staff.** A PM who wants to know a report finalized without a signature has to check `/inspections`; no Task is raised the way `renter-insurance-job.ts` raises one for its own alerts - deliberately, since auto-finalizing IS the terminal action here, not a prompt for a human to act on.
- **Still no R-069/R-070-specific wiring** - the engine is now complete end to end (checklist → walk → photos → signature → lock, staff or tenant), but door-codes-withheld-until-funds-clear (R-069) and the side-by-side move-in/move-out comparison via `moveInItemId` (R-070) remain those items' own work.

---

## R-069 — Keys withheld until move-in funds clear
**Commit:** `07e2bb8`  ·  **Date:** 2026-08-19

**What it built.** R-068 already shipped the tenant-signed condition report half of INSP-01; this item was the remainder - "key/code issuance logged, and door codes withheld until move-in funds show cleared (certified funds supported)." `packages/core/payments/clearing.ts` adds `fundsCleared()`: `Payment.status === 'SETTLED'` already means "received" (per `recordOfflinePayment`'s own comment), but only means "safe to act on" immediately for a certified channel - ACH/card genuinely settled by Stripe, cash, money order. An `OFFLINE_CHECK` needs a 5-day hold (`CHECK_HOLD_DAYS`, a plain literal, no statute concept to hang it on) before it's trusted for something as hard to reverse as handing over keys. A new daily job, `deposit-clearing-job.ts`, walks every CASH-deposit lease with no `Deposit` row yet, checks whether its deposit charge is fully paid AND every settling payment has actually cleared, and if so creates the `Deposit` liability row (`chargeDeposit()`'s own R-063 comment named this item as the one to do that) and raises a `lease.deposit_cleared` Task. A new privileged/MFA-gated permission, `accesscode.issue`, and a new `issueAccessCodeToTenant` action release a code to the tenant - hard-blocked (no override) until `lease.depositCents === 0 || lease.deposits.length > 0`. The lease detail page gained an `AccessCodesPanel`: a withheld-funds banner, and per-code "Issue to tenant" buttons that flip to "Issued <date>" once logged. Issuance is never a new column - `accesscode.issued` is an `AuditLog` entry keyed to the LEASE, and `accessCodesForLease()` derives "issued to this tenancy" from the latest matching row, the same "derive, don't duplicate" call `inspectionStatus()` already makes.

**What it decided.** Recorded as **D-59**:
- **Only the deposit gates release, not first month's rent too** - `chargeDeposit()`'s own comment ties "move-in funds" specifically to the deposit; rent is an ordinary collection concern with its own dunning path.
- **A hard block, not a warn-and-override**, unlike the notice-period/retaliation warnings (R-055, R-066) - whether the money is safe to act on is not a judgment call a staffer might reasonably override, it is the entire point of the rule.
- **`fundsCleared()` is computed live off `Payment.channel`/`status`/`receivedAt`, never a stored `clearedAt`** - one less place for the arithmetic to drift from the rule that produced it.
- **A credited/waived deposit never creates a `Deposit` row.** `deposit-clearing-job.ts` only counts ledger entries that carry a real `Payment` as "settling" - a waiver zeroing the balance is not cash actually held, so there is no liability to record.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **A real bug found and fixed mid-build, not in the shipped feature**: `ROLE_DEFINITIONS` in `packages/core/rbac/permissions.ts` is seed data (D-5) - editing it does nothing to an already-seeded database's `Role` rows until `db:seed`/`db:seed:test` reruns. The new `accesscode.issue` permission silently denied the owner role in the e2e run until `npm run db:seed:test` was rerun; worth remembering for any future item that adds a permission against a database that already has roles seeded.
- **A second real bug, the "Server Action refresh trap" CLAUDE.md already documents, hit again**: `issueAccessCodeToTenant` originally called `revalidatePath` after logging the issuance, which re-rendered the lease page's Server tree as part of the action's own response - since `issuedAt` was now populated, the refreshed tree swapped the button for "Issued" before the client's local `useActionState` result could ever show the code. Fixed by dropping `revalidatePath` entirely, matching `revealAccessCode`'s own existing posture: the code lives only in local client state, and the persisted "Issued" label appears on the next real navigation.
- **No UI for the reverse case** - a `Deposit` row that should exist but never will (a lease whose deposit charge is refunded, waived, or replaced with a surety bond after money was already collected) has no path to unwind here; that is deposit-disposition territory (R-071), not this item's.

---

## R-071 — Deposit disposition
**Commit:** `9bf20d9`  ·  **Date:** 2026-08-19

**What it built.** The rest of `Deposit` - `dispositionDueOn`, `dispositionSentAt`, `forwardingAddress`, `appliedCents`, `refundedCents` all existed on the schema since R-041, unwritten until now. `startDepositDisposition()` (called best-effort right after `changeLeaseStatus` commits a lease to ENDED/TERMINATED, the same posture `chargeDeposit()`/`syncLease()` already take) freezes the statutory deadline from `Lease.moveOutAt` - the REAL move-out fact, not R-070's merely-planned `noticeEffectiveOn` - and snapshots the tenant's forwarding address. A new daily job (`deposit-disposition-reminder-job.ts`) raises a ROUTINE Task at 50% elapsed and a URGENT one once overdue, each exactly once. A new `DepositDeduction` model lets staff itemize deductions, each optionally linked to a work order, a move-out inspection photo, or an uploaded invoice - "unsupported" (INSP-03's own word) is derived from all three being absent, never stored. `depreciationGuidance()` prorates a claim against staff-supplied age/useful-life estimates, flagging a claim that exceeds it (the "full replacement cost on nine-year-old carpet loses in court" case from the PRD itself). A new page, `/leases/[id]/deposit`, lets a PM build the list, see the running totals (`computeDisposition()` - held, deducted, the lease's own outstanding ledger balance netted in, refund due or a disclosed shortfall) and finalize: locks the deductions, computes final totals, and creates a real `Notice` (a new `DEPOSIT_DISPOSITION` type) with the itemized letter as its body - then hands off directly to R-051's existing `/notices/[id]` page for generating the PDF and recording its service to the forwarding address, unmodified.

**What it decided.** Recorded as **D-61**:
- **The countdown freezes from `Lease.moveOutAt`, never `noticeEffectiveOn`** - "the recorded move-out date" (INSP-03's own words) is a fact, not a plan, and the two can differ by weeks.
- **The letter reuses R-051's Notice machinery unmodified** rather than a second document pipeline - `dispositionLetterText()` is a plain string template (the same shape `nonRenewalNoticeText()` already established), and "delivery... logged" needed zero new code beyond one new entry in `KNOWN_NOTICE_TYPES`.
- **A shortfall beyond the deposit is disclosed in the letter, never auto-charged.** Collecting from a tenant who has already moved out and whose billing has been canceled is a real, separate problem - left as a named gap rather than half-solved here.
- **`Deposit.appliedCents`/`refundedCents` are written directly, not derived from a movement log.** `depositHeldCents()`'s own R-041 comment gestured at a `DepositMovement` table that the schema was never actually given; `computeDisposition()` writes the two flat integers the schema really has.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **No collection path for a shortfall** (deductions plus an outstanding ledger balance exceeding what was held) - disclosed in the letter's own text, nothing more. A future item owning post-move-out collections would need to decide how to actually re-bill someone who has left.
- **No UI for editing or retracting a finalized disposition.** Once `dispositionSentAt` is set the deduction list locks for good - a mistake found after finalizing has no path back here; it would need a correction on the Notice/ledger side directly, the same way every other locked evidence artifact in this product is corrected (a reversing entry, never an edit).
- **Depreciation guidance is a flat straight-line proration with staff-supplied inputs**, not a jurisdiction-specific useful-life table - no state publishes one this product could read instead, so age and useful life are estimates a PM types in per deduction, not looked up.

---

## R-070 — Move-out inspection: side-by-side comparison + auto-scheduled walkthrough
**Commit:** `6ab55ae`  ·  **Date:** 2026-08-19

**What it built.** INSP-02's two acceptance criteria. The comparison itself needed no new pairing logic - `InspectionItem.moveInItemId` already existed on the schema (added speculatively at R-068, unused until now) as a real FK from a move-out item to its move-in counterpart. `itemsFromMoveIn()` (`apps/web/lib/inspections/move-out-copy.ts`) copies a lease's own most recent MOVE_IN inspection's rooms/items into fresh rows with that FK set; `startInspection` now prefers this over the picked template whenever the type is MOVE_OUT or PRE_MOVE_OUT and a move-in inspection exists on record, and `getInspection`'s query includes the pair directly so the lease page needs no second query. `InspectionItemForm` grew an optional `moveIn` prop rendering a read-only "At move-in" panel (condition, notes, photos) beside the editable move-out fields. The scheduling half: a new `JurisdictionRule.preMoveOutWalkthroughRequired`/`preMoveOutWalkthroughDaysBefore` pair (nullable, "unreviewed" is a real third state, matching `sourceOfIncomeProtected`'s own posture), and a new daily job (`pre-move-out-scheduling-job.ts`) that treats a lease's own `noticeEffectiveOn` (R-066) as "a move-out is scheduled," creates a PRE_MOVE_OUT inspection with items copied from move-in, schedules it `preMoveOutWalkthroughDaysBefore` days ahead of the move-out date (clamped to not-before-today), and raises a Task. `packages/core/inspections/comparison.ts` adds `conditionChange()` and `isFixableCondition()` - small, pure, and currently only exercised by the test suite; no UI reads them yet (a natural R-071 hook, not wired here).

**What it decided.** Recorded as **D-60**:
- **`preMoveOutWalkthroughDaysBefore` is real `JurisdictionRule` configuration (D-4), not a literal** - unlike R-069's `CHECK_HOLD_DAYS`, several states that grant this right (California) specify how far ahead of move-out it must happen, so it is a statutory fact, not business-risk policy.
- **"A move-out is scheduled" is read as `Lease.noticeEffectiveOn` being set** - no second "move-out scheduled" fact was invented; R-066 already writes that column for either party's notice.
- **`startInspection` silently prefers the move-in checklist over the picked template** for MOVE_OUT/PRE_MOVE_OUT, rather than making the checklist field conditionally required - a one-line hint explains it instead of reaching for client JS.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **A real, unrelated bug found and fixed along the way**: `startInspection`'s lease lookup only ever matched `ACTIVE`/`MONTH_TO_MONTH` status - so a MOVE_OUT inspection started after the tenancy was already marked `ENDED` (the ordinary case) silently lost its `leaseId` link, and with it the comparison, the tenant-portal visibility rule, and R-071's future deposit-disposition evidence chain. Widened to also match `ENDED`/`TERMINATED`, most-recently-started first.
- **No UI reads `conditionChange()`/`isFixableCondition()` yet** - a "what got worse" badge or a filtered fixable-items list on the move-out page is real follow-on polish, not required by INSP-02's own acceptance text, and left for whoever needs it (likely R-071's itemized-deductions screen).
- **The pre-move-out walkthrough is calendared (`scheduledFor` set, a Task raised) but nothing reminds staff as the date approaches** - no digest, no escalation. `renter-insurance-job.ts`'s own alert-cadence pattern is the template to copy if that turns out to matter.
- **Texas seeded `preMoveOutWalkthroughRequired: false`** (no statutory right); every other state stays `null` (unreviewed) until an owner/attorney checks it, per D-60's own "third state" rule - nothing is auto-scheduled anywhere until that review happens.

---

## R-072 — Turnover / make-ready as a project
**Commit:** `6b7fe13`  ·  **Date:** 2026-08-20

**What it built.** LEASE-12's checklist, and INSP-06's auto-draft, over machinery this product already had rather than a new one. A new `TurnoverProject` model is only the envelope - property, unit, the departing lease, a target rent-ready date, and when it actually finished (`rentReadyAt`, no separate status column). Every checklist LINE is an ordinary `WorkOrder`, tagged with two new nullable columns (`turnoverProjectId`, `turnoverStage`) - `createWorkOrder`'s own R-024 comment already called a make-ready turn "ticketless," so vendor assignment, cost recording (`jobCostCents()`) and closing needed no new code at all. `startTurnoverProjectForLease()` starts the turn idempotently (`upsert` on the unique `leaseId`) from both places a unit goes MAKE_READY: the manual status change in `leases/actions.ts` and the nightly `unit.auto_make_ready` job - which, fixing a real gap, now actually stamps `Lease.moveOutAt` from `endsOn` for a lapsed lease, something `vacancy.ts`'s own comment already claimed it did. INSP-06's punch list drafts inside `lockInspection`'s own transaction: a locked MOVE_OUT report's POOR/DAMAGED/MISSING items (`isFixableCondition`, already built for R-070) become new, ticketless, unstaged work orders filed against whatever turnover project already exists for that lease. The unit detail page grew a `TurnoverPanel`: days-vacant (computed live from `Lease.moveOutAt` and, once one exists, the next lease's `moveInAt` - reusing R-050's own `daysOnMarket()`, storing neither), cost roll-up, the punch list table, an "add checklist item" quick form, a target-date field, and a "mark rent-ready" action that flips the unit MAKE_READY → VACANT.

**What it decided.** Recorded as **D-62**:
- **No second checklist table.** A turnover line is `WorkOrder` with two extra columns, not a new entity with its own status/vendor/cost machinery to keep in sync with the real one.
- **`TurnoverStage` is display vocabulary, not an enforced sequence.** Nothing blocks starting PAINT before REPAIRS closes - the backlog names an order, not a dependency graph, and no other workflow in this product enforces one either.
- **The days-vacant clock is never stored** - `daysVacant`/`daysVacantIsFinal` are computed at read time from `Lease.moveOutAt` and the next lease's `moveInAt`, the same facts R-050's vacancy tile already reads, rather than a third copy that could drift.
- **INSP-06's auto-draft does not retroactively catch up.** A MOVE_OUT report locked before the lease formally ends (no `TurnoverProject` yet) drafts nothing - the normal order is the lease ending first, and creating a project ahead of a real `moveOutAt` would anchor the whole clock on a fact nobody has yet.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **A real, unrelated bug found and fixed along the way**: `auto-make-ready.ts` flipped a lapsed lease's unit to MAKE_READY without ever writing `Lease.moveOutAt`, despite `vacancy.ts`'s own comment claiming it did - meaning R-050's vacancy-days tile silently fell back to the unit's `createdAt` for exactly the "lease lapsed with nobody clicking anything" path the job exists to handle. Fixed as part of wiring this item's own clock to the same fact.
- **No stage is auto-inferred for a punch-list finding.** A move-out inspection's DAMAGED countertop drafts as an unstaged work order; a PM triages it into REPAIRS/PAINT/etc. by hand rather than the product guessing from the item name.
- **No completion gate on "mark rent-ready."** A PM can mark the turn done with punch-list items still open - deliberate (a low-priority line item should not hold a rentable unit hostage), but it means the panel's "done" state is a PM's judgment call, not a database-enforced one.
- **No UI surfaces the portfolio-wide turnover list** - only the single most recent turn per unit, from that unit's own page. A "turns in progress across the portfolio" view (closer to R-081's territory) is real follow-on, not built here.

---

## R-073 — Periodic inspections
**Commit:** `1c6a3e1`  ·  **Date:** 2026-08-20

**What it built.** INSP-04's auto-scheduled half, over machinery R-068 already shipped rather than a new one - `PERIODIC`/`SEASONAL`/`DRIVE_BY` have existed in `InspectionType` since the engine's own migration, and a PM could already start one by hand from `/inspections/new`. What was missing was a calendar: a new `InspectionTemplate.defaultForType` column (nullable, unique per type) lets a PM designate one checklist as the default for each of the three types, from a small addition to the existing checklist editor. A new daily job, `periodic-scheduling-job.ts`, mirrors `pre-move-out-scheduling-job.ts`'s own PULL shape exactly: for each type with a default checklist assigned, it finds every unit with no open (unperformed) inspection of that type, computes whether the interval since the last one has passed, and if so creates the `Inspection` row (items copied from the default template, same as the manual path) plus a `Task` for staff. A unit never inspected before under this clock is due immediately, not a year from whenever its row happened to be created. The due-date math (`nextPeriodicDueDate()`, `packages/core/inspections/periodic.ts`) is the one piece of real logic - `lastPerformed` plus a fixed interval (12/6/3 months for PERIODIC/SEASONAL/DRIVE_BY), clamped to the target month's actual last day so a Feb-29 anchor doesn't roll into March - and has its own unit tests, alongside a full job test mirroring `pre-move-out-scheduling-job.test.ts`'s own fixtures.

**What it decided.** Recorded as **D-63**:
- **The scheduling job reads a real `defaultForType` column, never guesses a template by name or invents a new config table.** Same "nothing on file, so nothing happens" posture D-60 already established for an unreviewed jurisdiction fact, reused here for an undesignated checklist.
- **The cadence (12/6/3 months) is a bare literal, marked `ponytail:` in the source, not JurisdictionRule or Property config.** Nothing in the PRD makes inspection frequency statutory the way entry-notice hours are - inventing config nobody asked to vary would be the same trap D-59/D-60 both name for other numbers.
- **A never-inspected unit is due now, not anchored to `Unit.createdAt`.** The system has no real evidence a unit was ever periodically walked before this feature shipped; treating it as already-overdue is the honest default.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **No entry-notice compliance wired into PERIODIC scheduling**, despite `packages/core/entry/notice.ts` (R-027) existing exactly for a non-emergency entry into an occupied unit. This is a known gap, not a new one - `PRE_MOVE_OUT` (R-070, also an interior walk of an occupied unit) doesn't serve one either, and this item follows that existing precedent rather than fixing it for one type in isolation. A future item should wire `entryDecision()`/`entryNoticeText()` into whichever inspection-scheduling path serves the interior first, covering both types at once.
- **No "periodic inspections due" filtered view.** The existing `/inspections` list already shows every inspection including auto-scheduled ones; a dedicated "what's coming due" filter is small, real follow-on, not built here.
- **The cadence is portfolio-wide, not per-property or per-unit.** An owner who wants a different interval for one property (e.g. a Section-8 unit with its own recertification cadence, R-073's own downstream R-088) has no lever yet beyond the shared literal - promote `PERIODIC_INTERVAL_MONTHS` to config if that turns out to matter.

---

## R-074 — Tenant self-guided move-in report
**Commit:** `cb256fd`  ·  **Date:** 2026-08-20

**What it built.** INSP-05's self-guided walkthrough, over R-068's own engine rather than a new one - the tenant's own `Inspection`/`InspectionItem` writes are the identical shape the staff walk already makes, with the actual condition/photo-write logic (hash, EXIF capture time + geotag, storage put, `Document` row) factored out of `lib/inspections/actions.ts` into a shared `lib/inspections/item-writes.ts` so both the staff and tenant paths call the same code rather than two copies drifting. Three new tenant-portal actions (`recordItemAsTenant`, `recordItemPhotoAsTenant`, `finishInspectionAsTenant`) mirror `recordItem`/`recordItemPhoto`/`finishInspection` exactly, gated on a new `Inspection.selfGuided` column rather than `type === 'MOVE_IN'` alone. Staff opts a MOVE_IN inspection into self-guided from a checkbox on `/inspections/new` (shown only for that type), which also fires a `inspection.move_in_ready` notification with a direct portal link - the same "a report nobody learns exists helps nobody" posture `finishInspection`'s own signature-needed notify already takes. Once the tenant finishes recording every item, `finishInspectionAsTenant` sets `performedAt` and the page falls straight into the EXISTING sign form (`signInspectionAsTenant`, R-068 phase 2, unmodified) - no new sign-side code at all. A second `SCHEDULED_JOBS` entry in `auto-finalize-job.ts` covers the case the 3-day signature window can't: a report nobody has walked at all, after a 7-day window, raises one staff `Task` (D-9) plus a tenant reminder (`inspection.move_in_overdue`) rather than locking blank rows - idempotent via `createTask`'s own unique key, computed against the fixed due date rather than "today," so a job that keeps running past the deadline never raises a second Task. `/portal/papers` gained a second amber banner ("Complete your move-in walkthrough") alongside the existing "review and sign" one, from a new `inspectionsAwaitingTenantWalk` query.

**What it decided.** Recorded as **D-64**:
- **`Inspection.selfGuided`, not `type === 'MOVE_IN'` alone, is what authorizes a tenant's write.** A traditional staff-performed MOVE_IN inspection staff simply hasn't gotten to yet is otherwise indistinguishable from one a tenant was asked to complete themselves - the flag is what every tenant action and the walkthrough-window job both check.
- **The walkthrough window escalates to a staff Task; it never locks a never-walked report.** A locked report with every item still blank is not deposit-defense evidence (R-071 needs the opposite), so unlike the signature window this one hands the decision to a person - chase the tenant, or go walk it in person - rather than manufacturing a record.
- **Signing is not re-implemented for the self-guided path.** `finishInspectionAsTenant` only ever sets `performedAt`; the existing `signInspectionAsTenant`/`InspectionSignForm` from R-068 phase 2 do the rest, unmodified.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **No countdown shown to the tenant on the walkthrough page itself** - matches the existing signature-window page, which shows none either; the day-7 reminder notification is the parallel signal.
- **No portfolio-wide "self-guided reports outstanding" view** - only the tenant's own `/portal/papers` banner and the staff Task the escalation job raises surface it.
- **A tenant and staff writing items on the same still-unperformed report at once is not specifically guarded against** - an unlikely edge case for a single-family portfolio, no worse than any other concurrent-edit path in this codebase, and not worth solving for an S-sized item.

---

## R-075 — Shared `metrics` module in core
**Commit:** `ee8514e`  ·  **Date:** 2026-08-20

**What it built.** `packages/core/metrics`, but only for the metrics that had no single tested definition before this item — mapped first, rather than assumed: `occupancyRate` and `daysToFill` (occupancy) had never been computed anywhere at all; `firstResponseHours`/`resolutionByPriority` (time-to-resolve by priority) likewise, distinct from `sla.ts`'s own `firstResponseSlaState`, which classifies the same clock into a state rather than returning the duration; `renewalRate` and `turnCostCents` were correct but inline in two app-layer query functions, now extracted verbatim and imported instead. `getTurnoverForUnit`'s own days-vacant figure turned out to be a genuine bug-shaped simplification along the way: it called `daysOnMarket()` (a different, open-ended metric) with its `unitCreatedAt` fallback forced equal to `lastMoveOutAt` to neutralize a branch that does not apply to a terminal, already-filled vacancy — `daysToFill()` is that number, named and tested on its own rather than borrowed from a function built for a different question. `costPerUnitPerMonth` is a fresh division-only formula, not wired into a screen yet. Three of the ten named metrics — days-vacant (`daysOnMarket`, `@rental/core/units`), delinquency buckets (`bucketFor`/`delinquencyFor`/`agingTotals`, `@rental/core/ledger`), and `daysPastDue` (`@rental/core/money`, already bug-free per R-045) — were left exactly where they already lived, deliberately not relocated.

**What it decided.** Recorded as **D-65**:
- **"Every metric has one written, tested formula" is the rule this item satisfies — "every metric physically lives under `packages/core/metrics`" is not.** Moving three already-correct, well-tested modules into a new directory would be pure churn (every caller, every test file re-pointed) for zero behavior change, and no domain `index.ts` in this codebase re-exports a sibling's.
- **The turnover panel's roll-up-equals-sum check lives in `turnover.test.ts`**: the itemized per-work-order `costCents` and the reported `totalCostCents` header are both built from the identical `jobCostCents()` call, asserted to sum to the same total.
- **`occupancyRate`, `resolutionByPriority` and `costPerUnitPerMonth` are not wired into any screen yet** — R-076 (the five weekly saved views) and R-081 (maintenance analytics) are their first real callers.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **No new UI surfaces any of the newly-written metrics.** This item's own scope was the formula and its test; a dashboard tile or report column is real follow-on for whichever item actually needs to show the number (R-076 names five candidates).
- **`occupancyRate` treats a `DOWN` (long-term uninhabitable) unit as not-occupied, counted the same as `VACANT`** — a physical-occupancy reading, not an economic one that excludes non-rentable inventory from the denominator. Revisit if an owner wants the rentable-only number instead.

---

## R-076 — The five weekly saved views
**Commit:** `646c09e`  ·  **Date:** 2026-08-20

**What it built.** RPT-04's five reports, three of them existing pages found already complete or one fix away rather than duplicated. Rent roll + delinquency aging was already `/money/rent-roll` (R-044) - unchanged. Open work orders by age/priority was `/workorders`, whose own prior comment already named the gap ("bare, unsorted") - fixed in place (`priorityRank()` then age, an age-in-days shown per row). Vacancy/turn status extends `/vacancies` (R-050) with each unit's own turnover stage (`currentStageFor()`, derived from its `TurnoverProject`'s open work orders, never stored) and a "this week" leasing-activity summary (new leads, showings, applications). Cash summary per entity (new `/reports/cash`) groups `collectedVsBilled()`'s own arithmetic (R-050) by legal entity instead of the whole scope, plus each entity's biggest closed-job outflows. Upcoming critical dates (new `/reports/dates`) unions lease expirations, `filingCabinetAlertsDue()` (R-015), renter's-insurance expiry (R-067) and deposit-disposition due dates (R-071) into one real 60-day window. A new `/reports` index page links to all five; a new nav entry reaches it.

**What it decided.** Recorded as **D-66**:
- **No `SavedView` persistence model.** RPT-04's "as first-class saved views" reads as "real page routes," not a request for user-configurable persisted filters - nothing else in this product has one either.
- **No reserve-vs-target on the cash summary.** Nothing configures a reserve target anywhere in the schema; R-082 owns building that. Showing one here would be inventing a number nobody set.
- **No statutory compliance dates in the critical-dates report**, despite RPT-04's own prose naming "compliance" - that calendar is R-077's and does not exist yet; the page says so rather than overclaiming, matching R-050's own "Renewals & alerts" precedent.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **`resolutionByPriority` (R-075) still has no UI caller.** This item's own scope was reports built from EXISTING numbers plus the two genuinely missing ones; a resolution-time summary alongside the open-work-orders list is real follow-on, not required by RPT-04's own literal wording ("by age and priority" names the open list, not a closed-ticket average).
- **No e2e coverage of the turnover-stage display on `/vacancies`** (no fixture built a `TurnoverProject` for the drill-down test) - `currentStageFor()` itself has direct unit coverage; the page wiring is proven only by typecheck/build and the existing dashboard e2e's unchanged assertions still passing.

---

## R-077 — Compliance calendar
**Commit:** `c5baa53`  ·  **Date:** 2026-08-20

**What it built.** A generic `ComplianceItem`/`ComplianceCompletion` pair covering everything PROP-05 names except mortgage ARM/balloon and insurance renewal (those already had their own tested date field from R-015 and are unioned into the calendar rather than duplicated - `Mortgage`, `InsurancePolicy`). `ComplianceItem.type` is free-form (`Notice.type`'s own posture); a hand-written CHECK constraint enforces exactly one of `propertyId`/`legalEntityId` since a property-level license and an entity-level LLC annual report are different facts. `ComplianceCompletion` is the permanent log PROP-05 asks for - never edited or deleted, so "when was this last done" always reads from the most recent row. `nextComplianceDueDate()` (`packages/core/compliance`) advances a recurring item's due date from whenever it was actually completed, the same clamped-month-rollover shape `nextPeriodicDueDate()` (R-073) already established for inspections. A new daily job (`alert-job.ts`) raises a ROUTINE Task once an item enters its own per-item lead-time window and a URGENT one once overdue - an entity-level item spanning several properties gets flagged exactly once, deduped naturally through `Task.subjectId` being the compliance item's own id rather than any special-casing. New `/compliance` (list), `/compliance/new` (add item, scope picker toggles property vs. entity by type), and `/compliance/[id]` (completion history + record-completion form) pages. R-076's `upcomingCriticalDates()` now unions `ComplianceItem` in as a fifth source, closing the gap that item and R-050 both named honestly rather than overclaiming.

**What it decided.** Recorded as **D-67**:
- **One generic model, not a table per obligation category.** Every PRD-named obligation is the same shape (label, due date, optional recurrence, completion log) - the same "one queue, not many" argument D-9 already makes for `Task`, one level up.
- **Per-item lead time, not a global constant.** PROP-05's own examples span a 7-day smoke-detector check and a 60-day insurance-style notice; nothing in this product's history has ever found one number that fits every obligation.
- **`nextComplianceDueDate()` is a deliberate near-duplicate of `nextPeriodicDueDate()`**, not a shared/generalized function - D-65's own call again, for a ten-line function this size.

Full reasoning in `07-decisions.md`.

**What it left behind.**
- **No edit or delete for a `ComplianceItem` itself once created** - a wrong due date or label has no fix-up path from the UI yet; matches the "add a version, never edit" posture other config-shaped models in this product already take, but nothing here builds the "add a version" half.
- **No portfolio-wide "N items overdue" dashboard tile.** The compliance calendar is reachable from nav and from `/reports/dates`; a dashboard exception tile is real follow-on, not required by PROP-05's own acceptance text.
- **No e2e coverage of an entity-level item's own add/list flow** - the alert job's entity-level dedup has direct db-test coverage; the UI's entity-vs-property scope picker is proven only by typecheck/build, not a browser test.
