# 11 — Platform Administration PRD
## Platform principal, platform roles and permissions, the org console, support access, and the org-side screens that watch it

| | |
|---|---|
| **Document status** | v1.0 — D-349–D-357 accepted as proposed by Shane on 2026-10-27; OQ-27–OQ-30 answered as D-358–D-361. R-294a (the audit half of §5.4) is built |
| **Date** | October 27, 2026 |
| **Prepared by** | Shane LaBounty (brief) · Claude (code audit and spec) |
| **Source** | Shane's brief of 2026-10-27: "Since we have built it where it can white-label for multiple different companies, build out the platform super-user permissions and screens if we haven't created them already, to run at the platform level — create full PRDs first." |
| **Companion files** | `10-white-label-multi-org.md` (§9 is the sketch this document replaces; §5, §8, §M8 are extended) · `00-master-prd.md` EPIC 10 (ROLE) · `06-backlog.md` Milestone 19 · `07-decisions.md` (**overrides this document where they conflict**) · `../PROGRESS.md` |

> **What "super-user" means here, and what it does not.** The brief's word is *super-user*. This repo has refused one since July: **D-5** forbids an `isSuperuser` flag and any short-circuit in `can()`, `propertyScope()` or `checkMonetaryAuthority()`, and **D-320** made the platform admin a separate principal kind with **zero org permissions**. This PRD keeps both, unamended. The "super-user permissions" it designs are **platform permissions over platform resources** — organisations as records, platform admins, support grants, the jurisdiction rule library, cron health — held through rows exactly the way org permissions are (§3). Nothing in it lets a platform principal read or write a row inside an organisation except through a `SupportAccessGrant` the organisation can see (§4.7, D-320), and even then the actor is built from that row and passes through the unmodified `can()`.

> **On the numbering.** Highest row is R-301, highest decision D-348, highest open question OQ-26 (checked 2026-10-27). New: **R-302–R-306**, **D-349–D-357**, **OQ-27–OQ-30**. R-294 and R-295 are refined in place rather than re-listed; R-291, R-292, R-296 and R-300 gain a sentence each saying where their console half lives.

> **Conflicts with PRD 10 §9 found in the code — each is resolved below and none reverses a decision.**
> 1. **There is no bare host in any environment today.** `hostOrgId()` returns org #0 for every host not under `ORG_BASE_DOMAIN` (`apps/web/lib/auth/org.ts:38-40`), and `ORG_BASE_DOMAIN` is unset everywhere because the neutral domain is not bought (D-324). "`/platform` on the bare base host" cannot be built or tested as written. → `PLATFORM_HOST`, §2.2, D-350.
> 2. **An org-less audit row cannot exist.** `AuditLog.orgId` is `NOT NULL @default("org_0")` (`packages/db/prisma/schema.prisma:7280-7282`) and `recordAudit` only sets it when a caller passes one (`packages/core/audit/record.ts:107`), so a platform action audited today lands **silently in org #0's trail** — D-348 names this exact ceiling. And `currentAuditActor()` maps every non-staff principal to `TENANT` (`apps/web/lib/audit/index.ts:43`), so a platform session would be audited as a tenant (guarantors already are). → §5.4, D-352.
> 3. **"An actor with the owner's scope and `kind: 'platform'`" is refused by every admin page and breaks every writer.** `requireStaff()` redirects any kind but `staff` (`apps/web/lib/auth/guard.ts:63`), the whole `(admin)` tree sits behind it (`app/(admin)/layout.tsx:28`), and `currentActor()`'s `default` branch loads a **tenant** actor for any unknown kind (`apps/web/lib/auth/actor.ts:228-229`). About 143 writers stamp `actor.id` into a `StaffUser` foreign key (`createdByStaffId: actor.id` and kin, `apps/web/lib/**`), so a support actor that writes either fails on the FK or needs every one of them rewritten. → read-only grants (D-353, OQ-27).
> 4. **"The owner's scope" carries an unlimited money ceiling.** The owner role's ceilings are `null`, and `checkMonetaryAuthority` reads `null` as unlimited (`packages/core/rbac/authority.ts:55`). "Money actions refused under a grant" therefore has to come from the support actor's *data* (ceilings `0`, no money permissions), never from a branch in that function, which D-5 forbids. → D-353.
> 5. **Any org's owner can publish a statute for every org.** `JurisdictionRule` is org-less (`schema.prisma:7046`; `tests/invariants/org-01-05-06.test.ts:80`), the owner role holds every permission including `jurisdiction.write` (`packages/core/rbac/permissions.ts:264-268`), and `createRuleVersion` checks only that (`lib/jurisdiction/actions.ts:183`), then audits with no org, so the row lands in org #0 (`:292`). With org #1 live, its owner could change Texas's late-fee cap for org #0's tenants. PRD 10 keeps the table org-less and never says who maintains it. → the platform does (§4.11, D-355).
> 6. **No "fresh MFA" helper exists.** PRD 10 §8 asks for "fresh MFA" on export. `authenticatedAt` is written into the JWT (`apps/web/auth.ts:293`) and never exposed, and nothing re-proves a second factor mid-session. → step-up, §2.4.
> 7. **The org has no audit page.** `audit.read` exists (`permissions.ts:64`) and gates no route; `auditTrailFor` has no page caller. PRD 10 §9's "the org's own audit page lists the grant" has nothing to extend. → §4.15.
> 8. **The per-org kill switch would hold the break-glass notice.** D-347 checks `Organization.notificationsEnabled` in `deliverOverChannel` for **every** send so no caller can skip it, and an org whose notifications are switched off is the likeliest org to need break-glass. → OQ-28.
> 9. **`OrgInvite` belongs to no row.** PRD 10 §1.2 specifies it, D-323 depends on it, R-288 bootstrapped owners with `db:create-owner --org` instead, and no backlog row builds it. → R-304.

## 0. What exists and the gap (2026-10-27 audit)

| Area | Today | Gap | Rows |
|---|---|---|---|
| Platform principal | None. `Principal.kind` is `'staff' \| 'tenant' \| 'guarantor'` (`apps/web/auth.ts:42-57`); `Actor.kind` adds `vendor`, `system` (`packages/core/rbac/can.ts:35`). No `PlatformAdmin` model, no `/platform` route (`grep` 2026-10-27: zero hits). | Principal, credential, session, host | R-294 |
| Host | `orgSlugFromHost`/`hostOrgId` (`lib/auth/org.ts:27-45`): under the base = that org, bare base = no org, anything else = org #0. `proxy.ts` resolves no org (D-345) and runs only the demo gate and CSP (`apps/web/proxy.ts:90-124`). | A host that serves the console and nothing else, configurable before the domain exists | R-294 |
| Session | One Auth.js instance, JWT, 12 h (`auth.ts:65,75`), host-only cookie; `principalIsStillValid` re-proves host org and membership per request (`lib/auth/org.ts:53-87`). | A second, isolated session for platform admins; a third, grant-bound one for support | R-294, R-295 |
| MFA | TOTP via `createTotpEnrolment`/`verifyTotp` (`packages/core/auth/totp.ts:38,58`); seed sealed with `sealSecret` under purpose `mfa-secret` (`packages/core/auth/secret-box.ts:37,63`; `lib/auth/actions.ts:273`); recovery codes hashed (`schema.prisma:4486-4490`). Optional for staff; privileged permissions demand `mfaVerified` (`permissions.ts:190-226`). | Mandatory for platform; step-up for dangerous acts | R-294 |
| Lockout, rate limit | `RATE_LIMITS` (`packages/core/auth/rate-limit.ts:31-51`), `LOCKOUT_THRESHOLD = 5` (`:109`), keys `login:staff:${orgId}:${ip}` (`lib/auth/actions.ts:118`). | Platform keys and a tighter policy | R-294 |
| Bootstrap | `db:create-owner` (`packages/db/prisma/create-owner.mts`, `--org`); `refuseUnlessDemoDatabase` checks the URL, not `NODE_ENV` (`demo-database-guard.mts:17-20`). | `db:create-platform-admin` with the same URL discipline | R-294 |
| Permissions | One catalogue (`PERMISSIONS`, `permissions.ts:9-169`), roles as data (`ROLE_DEFINITIONS`, `:254`), owner = every permission (`:268`). Last-owner refusal as a pure function (`lib/staff/rules.ts:35`). | A platform catalogue, platform roles as rows, the same last-owner rule | R-302 |
| Audit | `recordAudit` (`packages/core/audit/record.ts:85-115`), `ActorType` = STAFF, TENANT, GUARANTOR, VENDOR, SYSTEM (`schema.prisma:443-451`), append-only by `reject_mutation()` trigger. | `PLATFORM` actor, `supportGrantId`, org-less rows for platform only | R-294, R-295 |
| Org health | `jobHealth(orgId)` (`lib/jobs/queries.ts:66`), `deadLetteredEvents(orgId)` (`lib/jobs/outbox.ts:196`), per-org cron children with a `cron.daily` `JobRun` claim (`lib/cron/per-org.ts:53-151`, D-346). All are org-scoped reads. | An org-less summary the console can read without a grant | R-303 |
| Kill switch | `Organization.notificationsEnabled` (`schema.prisma:495`, D-347); "flipped by SQL until R-294". | A console toggle | R-306 |
| Jurisdiction | Org-less table, edited at `/jurisdiction` by any holder of `jurisdiction.write` — every org's owner (`app/(admin)/jurisdiction/page.tsx:52`; `lib/jurisdiction/actions.ts:183`). | Platform-published; orgs read | R-305 |
| Org lifecycle | No `Organization.status` (R-300 adds it, D-338). No `OrgInvite`. | Console actions for create, invite, freeze, offboard, fee | R-304, R-300, R-296 |
| Support access | None. `lib/portal/guard.ts:25` anticipates "an impersonation feature … with an audit entry"; nothing implements it. | Grant, entry, banner, org approval, org audit page | R-295 |

## 1. Principles

1. **Two catalogues, one discipline.** Org permissions (`PERMISSIONS`) and platform permissions (`PLATFORM_PERMISSIONS`, §3) are disjoint vocabularies checked by two functions, `can()` and `canPlatform()`. Neither has a bypass; each denies by default; each grants only through rows that are visible and revocable. `can()` is not edited by this PRD.
2. **The platform sees organisations, not their contents.** Platform code reads an allowlisted set of tables (§4.3, PLAT-03): the organisation row, its integration *statuses*, its owners' names and emails, org-less health counts, grants, platform rows. Anything a renter, vendor or staff member typed is inside the org.
3. **The only way in is a grant row the org can read** (D-320), and a grant is a separate session on the org's host, bound to the row, re-checked on every request.
4. **Every platform act is audited in the same transaction**, as `actorType: PLATFORM`, in the org it was about when it was about one (so the org sees it), org-less only when it was about the platform itself.
5. **Dangerous acts need a second factor proved within ten minutes**, not merely a session that once proved one.

## 2. Platform principal and identity

### 2.1 Who is a platform admin

A `PlatformAdmin` row (§5.1), with its own credential, **no `StaffUser` row, no `OrgMembership`, no `StaffAssignment`**. A human who is both Shane-the-platform-operator and an org #0 owner holds two identities with two emails or the same email in two tables; they never merge, so an org grant can never be reached by signing in to the platform or the other way round.

### 2.2 Host

- **`PLATFORM_HOST`** (env, e.g. `admin.<neutral-domain>` or the bare base itself) is the one host that serves `/platform/**` and `/platform/api/auth/**`. **On any other host those paths are `notFound()`**; on `PLATFORM_HOST` every non-platform path is `notFound()` except `/` (the neutral page, D-345) and static assets. Unset = the console does not exist in that environment.
- `hostOrgId()` returns `null` for `PLATFORM_HOST`, so every org sign-in there fails like a wrong password, as the bare base already does.
- **Production value:** the bare base (`PLATFORM_HOST = ORG_BASE_DOMAIN`), as PRD 10 §9 intended. **Development and e2e:** `platform.localhost` — Chromium resolves `*.localhost` to loopback, so Playwright can drive it on `:3100` without DNS while `ORG_BASE_DOMAIN` stays unset and every other host stays org #0 (D-344). D-350.

### 2.3 Credential and sign-in (stories PADM-01..03)

| ID | Story | Acceptance |
|---|---|---|
| PADM-01 | As a platform admin I sign in with email, password and a TOTP code. | Given an enrolled admin on `PLATFORM_HOST`, when password and code are correct, a platform session is created; a wrong password, unknown email, deactivated admin, or locked account all answer the same sentence in the same time. The two halves are the existing pattern: password → single-use `PLATFORM_MFA_CHALLENGE` token in an httpOnly cookie → code (mirrors `STAFF_MFA_CHALLENGE`, `schema.prisma:4336-4350`; `lib/auth/actions.ts:104-230`). |
| PADM-02 | TOTP is mandatory. | An admin with no `mfaEnrolledAt` reaches **only** `/platform/enrol-mfa` after the password; every other platform page and action refuses. Enrolment shows the QR and the secret as text (screen readers, password managers), confirms one code, then shows ten recovery codes once. The seed is sealed with `sealSecret(secret, 'platform-mfa')` — a **distinct HKDF purpose** from staff's `mfa-secret`, so the two key spaces cannot be confused (`secret-box.ts:39-56`). |
| PADM-03 | A lost device is recoverable without a database edit when another owner exists. | A recovery code works once and is struck. A `platform_owner` may reset another admin's MFA (`platformAdmin.manage`, step-up); the target's sessions die and their next sign-in goes to enrolment. The **last** owner who loses device and codes uses the bootstrap script's `--reset-mfa` (§2.6). |

**Session.** A **second Auth.js instance** (`basePath: '/platform/api/auth'`) with its own cookie names under the **`__Host-` prefix** (`__Host-platform.session-token`), which the browser refuses to set with a `Domain` attribute, so no later widening of the org cookie (the risk `principalIsStillValid`'s comment names, `org.ts:65-67`) can ever carry a platform session to an org host or the reverse. `Principal.kind = 'platform'`. **4-hour absolute lifetime, 30-minute idle** (against staff's 12 h, `auth.ts:65`): a platform session is rarer and more dangerous. Re-checked every request: admin active, `sessionsValidFrom` ≤ `authenticatedAt`, request host is `PLATFORM_HOST`.

### 2.4 Step-up ("fresh MFA")

`requirePlatform(permission, { stepUp: true })` refuses unless a TOTP code was verified **within the last 10 minutes** (`token.mfaVerifiedAt`, set at sign-in and by `/platform/step-up`). The refusal redirects to `/platform/step-up?next=…`, which asks for one code and returns. Step-up permissions are listed in §3.1. **Built once in R-294 as a shape both catalogues can use**: PRD 10 §8's owner export (R-299) and freeze (R-300) need the same thing on the org side and currently have nothing (conflict 6).

### 2.5 Lockout and rate limits

- `RATE_LIMITS.platformLogin: { limit: 5, windowMs: 15 * 60_000 }` per IP, key `login:platform:${ip}`; `mfaVerify` reused per challenge (`rate-limit.ts:40`).
- Per-account lockout reuses `lockoutUntil`/`LOCKOUT_THRESHOLD` (`rate-limit.ts:109-135`) on `PlatformCredential.failedLoginCount`. Crossing into lockout is an org-less `PLATFORM`-attributable audit row (`auth.platform_lockout`) **and** a notification to every other active `platform_owner` — the only platform-to-platform notification in v1.
- Platform sign-in is never reachable from an org host, so an org's shared office IP cannot burn the platform's budget and the reverse.

### 2.6 Bootstrap: `npm run db:create-platform-admin`

`packages/db/prisma/create-platform-admin.mts`, root script `dotenv -e .env.local -- node …`.

- `--email --name` creates an admin with `platform_owner`, an unusable random password, and prints a single-use `PLATFORM_PASSWORD_SETUP` link on `PLATFORM_HOST`; enrolment happens at first sign-in (PADM-02).
- **Refuses if any active `platform_owner` exists** — from then on admins are added in the console, where it is audited with a human actor. `--force` does not exist for this script.
- `--reset-mfa --email` clears one admin's MFA and bumps `sessionsValidFrom`; allowed only when that admin is the last active owner (the console covers every other case).
- **Checks the database it is actually pointed at, not `NODE_ENV`** (as `refuseUnlessDemoDatabase` does, `demo-database-guard.mts:12-20`): refuses `rental_test` and `rental_ci` (fixtures own those), and requires `--target <host>/<db>` equal to the URL's host and database, printed back before the write. The incident it prevents is the one CLAUDE.md records for `db:seed`: a script resolving to the Neon dev branch from `.env.local` when the operator meant somewhere else.
- Every write is audited org-less: `actorType: SYSTEM`, `actorRef: 'db:create-platform-admin'`.

### 2.7 Deactivation

`active = false` plus `sessionsValidFrom = now()`: every session dies on its next request (ROLE-06's mechanism, `auth.ts:296-306`). Every live grant the admin holds is **ended** (`endedByType: SYSTEM`) in the same transaction, which ends the support session too (§4.7). An admin is never deleted — audit rows name them.

## 3. Platform roles and permissions

### 3.1 Catalogue (`packages/core/rbac/platform.ts`)

| Permission | Lets the holder | Step-up |
|---|---|---|
| `org.read` | See the org list, an org's status, checklist, integration statuses, `OrgHealth`, open grants, `platformFeeBps`, owners' names and emails; the dashboard and settings pages | — |
| `org.create` | Create an organisation and invite its owner (D-323) | ✓ |
| `org.configure` | Edit name, slug (before go-live only), brand colours; flip `notificationsEnabled`; mark go-live (R-291 step 10) | — (kill switch: ✓) |
| `org.freeze` | Freeze with reason; restore within the window (R-300) | ✓ |
| `org.offboard` | Schedule `FROZEN → OFFBOARDED` (R-300) | ✓ |
| `org.feeSet` | Set `platformFeeBps` (D-322, R-296) | ✓ |
| `integration.provision` | Start, re-poll or retire an org's Twilio subaccount/number/10DLC and Resend domain on its behalf (R-292, R-293). Never reads a sealed secret | — |
| `grant.request` | Ask an org for support access | — |
| `grant.breakGlass` | Open a break-glass grant (§4.7) | ✓ |
| `job.rerun` | Re-trigger one org's cron child (D-356) | — |
| `jurisdiction.publish` | Publish a `JurisdictionRule` version (D-355) | ✓ |
| `audit.read` | Read the platform audit log | — |
| `platformAdmin.manage` | Invite, deactivate, reset MFA of, and assign roles to platform admins | ✓ |

Closed vocabulary, typed like `PERMISSIONS`; `isPlatformPermission()` mirrors `isPermission()` (`permissions.ts:175`). **The two sets share no string**, enforced by a unit test, so `can(actor, 'audit.read')` and `canPlatform(admin, 'audit.read')` can never be confused by a type that widened to `string`; the platform one is spelled `audit.read` only inside `PlatformPermission`.

### 3.2 Roles (rows, seeded, D-351)

| Role | Permissions | Who |
|---|---|---|
| `platform_owner` | all of §3.1 | Shane |
| `platform_support` | `org.read`, `integration.provision`, `grant.request`, `grant.breakGlass`, `job.rerun`, `audit.read` | a support hire, later |
| `platform_viewer` | `org.read`, `audit.read` | a bookkeeper or investor; no writes |

Money (`org.feeSet`), lifecycle (`org.freeze`, `org.offboard`), access (`platformAdmin.manage`) and law (`jurisdiction.publish`) are owner-only by construction, the same way `confidential.read` is owner-only on the org side (`permissions.ts:127-131`): by not being on another role's list, not by a role-name test.

### 3.3 The same no-bypass discipline as D-5

- `canPlatform(admin, permission)`: inactive → `inactive`; no live assignment whose role carries it → `no_permission`; step-up permission without a code in 10 minutes → `stepup_required`. Nothing else. No `isPlatformOwner` flag, no `role === 'platform_owner'` test anywhere, no wildcard.
- **Grants are rows** (`PlatformRoleAssignment`), revoked by setting `revokedAt`, never deleted (trigger).
- **Only a holder of `platformAdmin.manage` assigns roles**, which today means only an owner grants owner (foundation INV-28).
- **The last active `platform_owner` cannot be revoked or deactivated** — `platformRevokeRefusal(assignments, target)` is a pure function over a list passed as a value, unit-tested, exactly as `revokeRefusal` is (`lib/staff/rules.ts:35`; CLAUDE.md: a deployment-wide rule is covered by a unit test that takes the list as a value, not by e2e against the shared database).
- **An admin cannot change their own assignments.** Self-revocation of a non-last owner is the one exception, so a departing owner can leave cleanly.

### 3.4 Two-person rule — not in v1 (D-357)

Argued per candidate:

| Act | Two-person? | Why not, and what does the work instead |
|---|---|---|
| Break-glass | No | Its reason to exist is speed during an incident; a second approver at 2 a.m. is the incident getting worse. The **org's owners are the second party**, notified at once, and the grant is 60 minutes and read-only (D-353). |
| Offboard | No | Irreversibility is already behind a **90-day freeze window** (D-325) during which the owner can ask for restore. The window is the second pair of eyes, with the right person holding them. |
| Fee change | No | It changes the next invoice, not past ones; the owner is notified and sees it on their settings page. |
| Grant `platform_owner` | No, today | With one platform human (OQ-29), a two-person rule is a lockout. |

**Revisit trigger:** the third active platform admin. At that point "grant `platform_owner`" and "offboard" are the two acts that earn it.

## 4. Screens

All platform screens: `PLATFORM_HOST` only; the `(platform)` layout calls `requirePlatform('org.read')` first (ORG-05-style guard-first, PLAT-02); the brand is the product's neutral one, never an org's; every table collapses to labelled cards below 640 px with `break-words` on any email or slug (CLAUDE.md: a data value overflows the way a control does); every destructive action is a real `<form action>` with `useActionState` (works before hydration), its live region mounted outside anything that remounts; headings asserted by role in specs, never by text (the route-announcer trap).

### 4.1 Sign-in, MFA enrolment, step-up, own account — `/platform/login`, `/platform/login/mfa`, `/platform/enrol-mfa`, `/platform/step-up`, `/platform/account`

- **Who:** anyone (login); a half-signed-in admin (mfa, enrol); a signed-in admin (step-up, account).
- **Shows:** login: email, password, "Sign in". MFA: one 6-digit field (`inputmode="numeric"`, `autocomplete="one-time-code"`), "Use a recovery code" toggle. Enrol: QR, the base32 secret in a copyable `<code>`, confirm field, then the recovery codes once with "I've stored these". Account: name, email, MFA enrolled date, recovery codes remaining, "Regenerate recovery codes" (step-up), "Sign out everywhere".
- **Errors:** one sentence for every credential failure; lockout says when to retry, not why; rate limit says "wait N minutes".
- **AA:** the error is a `FieldError` tied by `aria-describedby`; the QR has the secret as its text alternative.

### 4.2 Dashboard — `/platform`

- **Who:** `org.read`.
- **Shows:** counts by org status (onboarding / active / frozen / offboarding); **needs attention**, ordered: live break-glass grants, orgs whose last daily cron failed or did not run, dead letters > 0, integrations in `FAILED`/`RESTRICTED`, pending support requests older than 24 h, orgs with notifications switched off; the admin's own live grants with "Open" and "End".
- **Empty:** "No organisations yet" with "Create organisation" if `org.create`.
- **Stale data:** every `OrgHealth` figure shows its `computedAt`; older than 26 h reads "health not reported since …" in place of the numbers, so a dead cron cannot look like a healthy org.

### 4.3 Organisations — `/platform/orgs`

- **Who:** `org.read`.
- **Shows:** one row per org: name, slug (link to host), status, checklist *n*/10 (R-291), Stripe/Twilio/Resend status chips (R-275), last daily cron outcome and age, dead letters, open grants, `platformFeeBps` as a percentage. Filter by status; search by name/slug.
- **Reads, and only these** (PLAT-03): `Organization`, `OrgHealth`, `OrgIntegration` (`provider`, `status`, `statusReason`, `updatedAt` — never `config` beyond the non-secret display fields, never `secret`), `SupportAccessGrant`, `OrgInvite`.
- **Empty / error:** "No organisations match"; a failed load is the platform error boundary, never a partial list.

### 4.4 Organisation detail — `/platform/orgs/[slug]`

- **Who:** `org.read`; actions per permission.
- **Shows:** status and its history (from the org's own `PLATFORM` audit rows); the provisioning checklist (R-291's derived steps, read from facts the console may see — membership counts, `OrgIntegration` statuses, the `OrgHealth` booleans R-291 adds; never a property or template list); integrations panel with the provider's reason verbatim and "Re-poll" (`integration.provision`); health panel (last run per cron child, failed runs 7 d, dead letters, queued and held notifications, `notificationsEnabled`); grants panel (open, pending, last 20 ended, each with reason, who, duration, approver); fee; **owners' contact**: name and email of each active owner-role member, for invites and support calls (D-354); pending invites with "Resend" / "Revoke".
- **May NOT show without a grant, and the page says so in one line:** properties, units, tenants, leases, ledger or balances, messages, tickets, work orders, documents, templates, staff other than owners, the org's audit log, job error text. "Viewing inside this organisation needs a support grant." with "Request access" (`grant.request`) and "Break glass" (`grant.breakGlass`).
- **Actions:** configure (§4.6), freeze / restore / offboard (§4.6), fee, kill switch, re-run cron (`job.rerun`), request / break-glass (§4.7).
- **Mobile:** panels stack; actions in a disclosure "Actions" menu built from `<details>` (no hydration needed).

### 4.5 Create organisation — `/platform/orgs/new` (D-323, R-304)

- **Who:** `org.create`, step-up.
- **Fields:** legal display name; slug (lower-case, `^[a-z0-9-]+$`, reserved words refused: `www`, `admin`, `platform`, `api`, `app`, the `PLATFORM_HOST` label); owner's name and email; `platformFeeBps` (default from `PLATFORM_DEFAULT_FEE_BPS`, owner-visible).
- **On submit, one transaction:** `Organization` (status `ONBOARDING` once R-300's column exists), `OrgInvite` (hashed token, 7-day expiry, single use, email must match, role `owner` — foundation shape, PRD 10 §1.1), `org.created` and `org_invite.sent` audit rows **in the new org** (actor `PLATFORM`). The invite email goes through the notification engine (`account_access`, locked) on the org's host, built with `authUrl(orgId, '/invite/…')` (D-345).
- **Errors:** slug taken (says so — slugs are public hostnames, not an oracle); email invalid. The page never creates a `StaffUser`; acceptance does (§4.17).

### 4.6 Lifecycle and configuration — on `/platform/orgs/[slug]`

| Action | Permission | Form | Effect | Audit (in the org) |
|---|---|---|---|---|
| Edit name / brand colours | `org.configure` | name, two colours (CHECK `^#[0-9a-f]{6}$`, `schema.prisma:487-488`) with the AA preview `brandStyle()` already computes | row update | `org.configured` |
| Change slug | `org.configure`, step-up | only before go-live; typed confirmation of the old slug | host changes | `org.slug_changed` |
| Notifications off / on | `org.configure`, step-up | reason required | `notificationsEnabled` (D-347): held, not suppressed | `org.notifications_switched` |
| Set fee | `org.feeSet`, step-up | basis points 0–1000, effective from the next invoice | R-296 | `org.fee_set` (+ owner notified) |
| Freeze / restore | `org.freeze`, step-up | reason; typed slug | R-300's state machine | `org.frozen` / `org.restored` (+ owners notified) |
| Schedule offboarding | `org.offboard`, step-up | only from `FROZEN`; typed slug; shows the purge date (window per D-325) | R-300 | `org.offboard_scheduled` |
| Re-run cron | `job.rerun` | which child (daily / notifications / escalations) | D-356 | `org.cron_retriggered` |

Refusals name the missing permission (same `/no-access` pattern as `guard.ts:104`) and step-up redirects back to the same action.

### 4.7 Support access — `/platform/orgs/[slug]/support`, `/platform/grants` (D-320, D-353, R-295)

**Request (normal path).** `grant.request`: reason (required, ≥ 20 characters, free text, shown to the org verbatim), duration (1 h / 4 h / 24 h, default 4 h). Creates a `REQUESTED` grant; every active owner of the org gets a `support_access` notification and a Task (D-9's one queue) "Support is asking to view your organisation". **Nothing opens until an owner approves** (§4.14).

**Break-glass.** `grant.breakGlass`, step-up: reason (required), fixed **60 minutes**, no approver. Opens immediately. Every active owner is notified at once on every channel their preferences allow, on the locked `support_access` category (OQ-28 for the kill-switch case), and the org's dashboard carries an unacknowledged banner until an owner presses "Seen" (§4.16). At most **one live break-glass grant per org**.

**Entering.** "Open" on a live grant mints a single-use `SUPPORT_ENTRY` `AuthToken` (60-second expiry, subject = grant) and redirects to `https://<slug>.<base>/support/enter?token=…`. That route redeems it, checks the grant is live and its admin active, and sets a **third session**: `Principal.kind = 'support'`, `grantId`, host-only cookie, expiry = the grant's. Every request re-checks: grant not ended, not expired, admin active, host = the grant's org. **The admin's platform session is never on this host, and this session is never on `PLATFORM_HOST`.**

**What the support session can do.** `currentActor()` gains an explicit `case 'support'` → `loadSupportActor(grantId)`, which builds an `Actor` from the grant row: `kind: 'support'`, `orgId: grant.orgId`, one synthetic assignment `{ orgId, propertyId: null, legalEntityId: null, permissions: SUPPORT_PERMISSIONS }`, `ceilings: { approveWorkOrderCents: 0, waiveFeeCents: 0 }`, `mfaVerified: true`. `SUPPORT_PERMISSIONS` = every `*.read` permission **except `confidential.read`** (safety cases, RISK-04) plus `audit.read`, **and no write permission at all** in v1 (D-353, OQ-27). `accesscode.reveal` is not a read and is not on the list: a lockbox code is a key to somebody's home. `can()`, `propertyScope()` and `checkMonetaryAuthority()` are unchanged — the refusals come from the data, as D-5 requires (conflict 4). `requireStaff()` admits `kind: 'support'` alongside `'staff'`; every write path already goes through `requirePermission`/`requireScope`/`requireMonetaryAuthority` for a write permission, which the support actor does not hold (PLAT-06 proves it for every manifest action).

**While acting: the banner.** Every page on the org host under a support session renders, above the header, an `<aside aria-label="Support session">`: "You are viewing **{org}** as platform support · read-only · ends at {time, org's timezone} · [End now]". Not `role="alert"` (the route announcer already is one, CLAUDE.md), contrast ≥ 4.5:1 in both themes, stays visible at 375 px (wraps, never truncates the end time).

**Ending.** "End now" (either side), owner revoke, expiry, or admin deactivation sets `endedAt`/`endedByType`; the next request on the support session fails `principalIsStillValid` and lands on a page saying the session ended and why. `/platform/grants` lists the admin's own grants (live, pending, ended) and, with `audit.read`, every admin's.

### 4.8 Platform admins and roles — `/platform/admins`, `/platform/admins/new`, `/platform/admins/[id]`

- **Who:** `platformAdmin.manage` for all three; nobody else sees the roster.
- **Shows:** name, email, roles, MFA enrolled, last sign-in, active; per admin, their assignment history (granted by, when, revoked by, when).
- **Actions (step-up):** invite (creates `PlatformAdmin` + `PLATFORM_PASSWORD_SETUP` link by email); assign / revoke role; reset MFA; deactivate. The last-owner refusal is shown as a sentence before the press, and enforced on the press.
- **Errors:** "This is the last platform owner. Add another owner before removing this one." Duplicate email refused.

### 4.9 Platform audit log — `/platform/audit`

- **Who:** `audit.read`.
- **Shows:** every `AuditLog` row with `actorType = PLATFORM` (any org, or none) and every org-less row: when, admin, action, org (link), grant (link), reason. Filters: admin, org, action, date range; CSV export of the filtered set.
- **Does not show:** org rows written by org staff. The one exception is rows written **under a grant**, which carry `supportGrantId` and are the platform's own acts.

### 4.10 Cross-org job health and dead letters — `/platform/jobs`

- **Who:** `org.read`; re-trigger with `job.rerun`.
- **Shows:** per org, per cron child: last run, outcome, age; failed runs in 7 days; dead-lettered outbox events (count only); held notifications. Sorted worst first.
- **Source:** `OrgHealth` only (D-354) — counts, job types, timestamps, never `JobRun.error` or `result` (free text that can name a tenant). Error text is behind a grant, where the org's own `/jobs` page shows it (`app/(admin)/jobs/page.tsx:38`).
- **Action:** "Re-run" re-triggers that org's cron child (D-356); its result shows when `OrgHealth` next updates.

### 4.11 Jurisdiction rule library — `/platform/jurisdiction`, `/platform/jurisdiction/new` (D-355, R-305)

- **Who:** `org.read` to view; `jurisdiction.publish`, step-up, to publish.
- **Shows:** today's `/jurisdiction` list (state, local jurisdiction, version, effective dates, citation, reviewer, unreviewed badge) plus **which orgs have properties in each state** (count of orgs, from `OrgHealth.states`) so the publisher knows whose tenants a version governs.
- **Publish:** the existing `createRuleVersion` form and validation moved under the platform guard, including R-162's rule that a founding version needs a citation and reviewer (`lib/jurisdiction/actions.ts:196-212`). Audited org-less, `actorType: PLATFORM`. Orgs whose properties are in the state get a notification "A new {state} rule takes effect on {date}" (owners, `compliance_due`).
- **Org side:** `/jurisdiction` becomes read-only for every org: the "New version" button and `/jurisdiction/new` go, and `jurisdiction.write` leaves the org catalogue (§M). Per-org stricter-only policy stays R-298's.

### 4.12 Platform settings — `/platform/settings`

- **Who:** `org.read`. **Read-only**: nothing here can be changed from the browser, because a switch that needs the database cannot stop a database incident (D-347's argument for keeping `NOTIFICATIONS_ENABLED` an env var).
- **Shows, as on / off / set / unset, never a value for anything secret:** `NOTIFICATIONS_ENABLED`, `NOTIFICATIONS_SANDBOX_TO` (set or not), `ORG_BASE_DOMAIN` and `PLATFORM_HOST` (values — they are hostnames), `DEMO_ACCESS_PASSWORD` (set or not), `CRON_SECRET`, `STRIPE_SECRET_KEY` mode (test / live from the prefix, never the key), `STRIPE_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `RESEND_WEBHOOK_SECRET`, `INBOUND_EMAIL_SECRET`, `AUTH_SECRET` (set or not), `VERCEL_ENV`, the deployed commit SHA. Each line says what it does and where it is changed ("Vercel → Project → Environment Variables").

### 4.13 Platform-side empty, error and frozen states, shared

A frozen or offboarding org is still listed and readable; its actions are only those R-300's state machine allows. An org with no `OrgHealth` row yet reads "not yet reported". The console never renders an org-owned query result, so it has no "out of scope" state; a refused action is `/platform/no-access` naming the permission.

### 4.14 Org side: support access settings — `/settings/support-access` (R-295)

- **Who:** an owner-role member (`staff.manage` and `audit.read` both held portfolio-wide — today's owner); read-only for `audit.read` holders.
- **Shows:** pending requests (admin name, reason, requested duration, requested at) with **Approve** (duration picker capped at the requested one, step-up) and **Deny** (optional note); live grants with time left and **Revoke now**; history of every grant with "What was viewed" linking to §4.15 filtered to that grant.
- **Rules:** approving needs an owner with a live membership in this org (DB-checked, §5.3); a support session can never reach this page (the actor lacks `staff.manage`), so support cannot approve itself.
- **Empty:** "Platform support has never asked to view your organisation."
- **AA / mobile:** each request is a card with its buttons labelled with the admin's name ("Approve request from Dana"), so two pending requests never share an accessible name (CLAUDE.md).

### 4.15 Org side: audit log — `/settings/audit` (new; nothing exists, conflict 7)

- **Who:** `audit.read` (owner and anyone they gave it to), scoped by `propertyWhere(scope)` like every list, plus org-level rows (`propertyId` null, `orgId` = actor's org) for portfolio-wide holders.
- **Shows:** when, who (staff name, "Tenant", "Vendor", "System: {job}", or **"Platform support: {admin name}"**), action, record link, reason. Filter by actor type, by grant, by date. A grant filter header shows the grant's reason, approver and window. CSV export.
- **Redaction:** rows are already redacted at write (`packages/core/audit/redact.ts`); `confidential.*` rows show only to `confidential.read` holders, as their own screens do.

### 4.16 Org side: break-glass notification and banner

- **Notification:** new locked category `support_access` (beside `account_access`, `packages/core/notifications/categories.ts:149,262-277`): "Platform support opened emergency access to {org} at {time}. Reason: {reason}. It ends at {time}. You can end it now: {link}." Email and SMS per preferences; locked because an owner who muted it could never learn their org was entered. Also sent (Task, not text) for a normal request.
- **Banner:** on every owner's dashboard until one owner presses "Seen": "Platform support used emergency access on {date} — see what was viewed." `<aside>`, not an alert.

### 4.17 Org side: accept an invitation — `/invite/[token]` (R-304)

- **Who:** anyone holding the link, on the org's host.
- **Flow:** shows the org's name and the invited email; set a password (existing strength rules); creates or reuses the `StaffUser` for that email (D-318), the `OrgMembership`, the owner `StaffAssignment` (`propertyId`/`legalEntityId` null, `orgId` set), marks the invite accepted, audits `org_invite.accepted` in the org; then MFA enrolment is offered and required before any privileged act (ROLE-05, unchanged).
- **Errors:** expired, used, revoked, wrong host → one sentence each, with "Ask whoever invited you to send a new one". An existing user signs in instead of setting a password.

## 5. Data model (R-294, R-295, R-302, R-303, R-304)

Hand-written SQL migrations; every invariant below that says "trigger" or "CHECK" is in the database, per this repo's style.

### 5.1 Identity

```
PlatformAdmin             id, email @unique (stored lower-case, CHECK), name, active @default(true),
                          sessionsValidFrom, createdAt, createdById? → PlatformAdmin, deactivatedAt?
PlatformCredential        platformAdminId @unique, passwordHash, passwordUpdatedAt,
                          mfaSecret? (sealed, purpose 'platform-mfa'), mfaEnrolledAt?, mfaRecoveryCodes String[],
                          failedLoginCount, lockedUntil?, lastLoginAt?
AuthTokenPurpose          + PLATFORM_MFA_CHALLENGE, PLATFORM_PASSWORD_SETUP, SUPPORT_ENTRY   (single-use, as every purpose but VENDOR_WORK_ORDER)
```

- `PlatformAdmin`, `PlatformCredential` refuse DELETE (trigger) — audit rows name them.
- `email` CHECK `email = lower(email)`; uniqueness is therefore case-insensitive without `citext`.

### 5.2 Roles

```
PlatformRole              key @id, name, permissions String[]          (seeded: platform_owner, platform_support, platform_viewer)
PlatformRoleAssignment    id, platformAdminId, roleKey, grantedById?, grantedAt, revokedAt?, revokedById?
                          partial unique (platformAdminId, roleKey) WHERE revokedAt IS NULL
```

- Assignment: DELETE refused; UPDATE may only set `revokedAt`/`revokedById` once (trigger).
- **Last owner, in the database too:** a constraint trigger (`DEFERRABLE INITIALLY DEFERRED`, as `staff_assignment_membership` is since D-348) refuses a commit that leaves zero live `platform_owner` assignments on active admins **once one has existed**. The pure function is the message; the trigger is the guarantee.
- `PlatformRole.permissions ⊆ PLATFORM_PERMISSIONS` is checked by a unit test over the seed, as role permissions are today.

### 5.3 Support access

```
SupportAccessGrant        id, orgId → Organization (Restrict), platformAdminId → PlatformAdmin (Restrict),
                          kind (REQUESTED | BREAK_GLASS), reason, requestedAt, requestedMinutes,
                          approvedByStaffId? → StaffUser, approvedAt?, deniedByStaffId?, deniedAt?, denialNote?,
                          startsAt?, expiresAt?, endedAt?, endedByType? (PLATFORM | STAFF | SYSTEM | EXPIRY), endedById?,
                          ownersAcknowledgedAt?, acknowledgedByStaffId?
```

Invariants (trigger unless stated):
- DELETE refused. `orgId`, `platformAdminId`, `kind`, `reason`, `requestedAt`, `requestedMinutes` immutable.
- Transitions only forward: pending → approved | denied | ended; approved → ended; once `endedAt`/`deniedAt` is set nothing else changes except the acknowledgement columns.
- CHECK: `kind = 'BREAK_GLASS'` ⇒ `approvedByStaffId IS NULL` and `expiresAt - startsAt <= interval '60 minutes'`; `kind = 'REQUESTED'` ⇒ `expiresAt - startsAt <= interval '24 hours'` and `startsAt` set only with `approvedAt`.
- Approval: `approvedByStaffId` must hold a live `OrgMembership` in `orgId` and a live owner-role `StaffAssignment` there with null property and entity (checked at commit).
- Partial unique: one live grant per `(orgId, platformAdminId)`; one live `BREAK_GLASS` per `orgId`.
- `orgId` here is the grant's subject, so the table is org-owned for ORG-06 and carries `orgId NOT NULL`; it is written only by platform code and by the org's approve/deny/revoke actions.
- Expiry needs no job: liveness is `endedAt IS NULL AND now() < expiresAt`, read on every request. A nightly sweep stamps `endedByType: EXPIRY` for the record.

### 5.4 Audit

```
ActorType                 + PLATFORM
AuditLog                  orgId String?  (default "org_0" DROPPED)
                          supportGrantId String? → SupportAccessGrant (Restrict — the table is append-only, CLAUDE.md)
                          CHECK (orgId IS NOT NULL OR actorType = 'PLATFORM')
                          CHECK (supportGrantId IS NULL OR actorType = 'PLATFORM')
                          @@index([supportGrantId]), @@index([actorType, occurredAt])
```

- Platform acts **about an org** carry that `orgId` (the org reads them, §4.15); acts **about the platform** (admin invited, rule published, sign-in lockout) are org-less. `actorRef` = the admin id, as it is for every non-staff actor (`record.ts:37-40`).
- **Dropping the default is what closes D-348's AuditLog ceiling.** `audit()` (`lib/audit/index.ts:58-62`) fills `orgId` from the current actor's org when the caller gives neither `propertyId` nor `orgId`, so the hundreds of existing callers keep working and the jurisdiction write stops landing in org #0; `recordAudit` callers outside a request (`auditAsSystem`) must pass one, and the CHECK makes a forgotten one fail loudly instead of silently filing it under org #0.
- `currentAuditActor()` gains explicit `platform` and `support` branches (`type: 'PLATFORM'`, `ref: adminId`, `supportGrantId` for support), and a `guarantor` branch while it is open (today guarantors are recorded as `TENANT`, `:43`).

### 5.5 Health (D-354)

```
OrgHealth                 orgId @id → Organization, computedAt,
                          lastRun Json   { daily: {at, outcome}, notifications: {…}, escalations: {…} },
                          failedRuns7d Int, deadLetters Int, queuedNotifications Int, heldNotifications Int,
                          activeOwners Int, activeMembers Int, properties Int, states String[],
                          checklist Json  (R-291's derived booleans, no names)
```

- **Written by the org's own cron child**, at the end of every per-org invocation (`lib/cron/per-org.ts` — daily, hourly notifications, 15-minute escalations), in the org's context, so the platform never runs the counting queries. Counts, booleans, timestamps and state codes only; a CHECK forbids nothing a CHECK can see, so the "no free text" rule is a unit test over the writer's output type.
- Org-owned for ORG-06 (`orgId` NOT NULL, it is the key), readable by platform code (PLAT-03 allowlist).

### 5.6 Elsewhere

- `Organization`: R-300's `status`/`frozenAt`/`offboardedAt`, R-296's `platformFeeBps`, R-289's logo — unchanged by this PRD.
- `OrgInvite` (PRD 10 §1.2) gains `invitedByType (STAFF | PLATFORM)` and `invitedById` in place of `invitedByStaffId`, because the first invite of every org is a platform admin's.
- `NOTIFICATION_CATEGORIES` + `support_access` (locked).
- `ORG_LESS` in `tests/invariants/org-01-05-06.test.ts:77-85` + `PlatformAdmin`, `PlatformCredential`, `PlatformRole`, `PlatformRoleAssignment` (each with its reason), so ORG-06 keeps proving every other model carries `orgId`.

## 6. Security and abuse

| Threat | Control |
|---|---|
| **Stolen platform password** | Mandatory TOTP (PADM-02); 5-per-15-min per-IP limit and per-account lockout that notifies the other owners (§2.5); 4 h / 30 min session; step-up for every dangerous act (§3.1); `sessionsValidFrom` kill. Even fully compromised: no org row is readable without a grant the org sees, and break-glass both notifies the owners and cannot write (D-353). |
| **Stolen `AUTH_SECRET`** | Forges any session including platform ones (same as today, `secret-box.ts:15-21`). Not mitigated in v1; the platform's seeds use a separate HKDF purpose so a key derived for one cannot open the other, and rotation re-enrols everyone. Recorded, not hidden. |
| **Insider browsing** (an admin who looks because they can) | The console cannot see inside an org (PLAT-03). Every entry is a grant with a reason the org reads verbatim; break-glass is loud by design (notification + banner + one live per org). Page views under a grant are **not** audited one by one in v1 (reads are not audit events anywhere in this product), so "what was viewed" is the grant's window plus every action. OQ-27's answer decides whether page views join. |
| **A grant that never ends** | Liveness is computed from `expiresAt` on every request; the DB caps break-glass at 60 min and requests at 24 h; deactivating the admin ends every grant in the same transaction; the owner can revoke at any time. |
| **Confused deputy across hosts** | The org comes from `Host`, never a cookie or form (D-344). Platform cookie is `__Host-` on `PLATFORM_HOST`; support cookie is host-only on the grant's org host and re-checked against `grant.orgId` every request; a `SUPPORT_ENTRY` token redeemed on another org's host fails (PLAT-09). Links built for owners use `authUrl(row.orgId, …)` (D-345). |
| **Support approving itself / escalating** | A support actor holds no write permission; approval is a DB-checked owner-member act; `staff.manage` is not on `SUPPORT_PERMISSIONS`. |
| **Platform admin escalating themselves** | Only `platformAdmin.manage` assigns roles; nobody edits their own assignments; step-up on every assignment; DB trigger on last owner. |
| **Org owner self-publishing law** | `jurisdiction.write` leaves the org catalogue (D-355). |
| **Bootstrap misuse** | Script refuses once an owner exists, refuses test databases, requires a typed `--target` (§2.6). |
| **Enumeration via the console** | Slug availability is public by nature (it is a hostname). Invite acceptance answers expired, used and nonexistent tokens identically. |

## 7. Testing

### 7.1 The PLAT invariant set (`tests/invariants/plat-*.test.ts`, driven by the same discovery as ORG-01..08)

| ID | Invariant | Mechanism |
|---|---|---|
| PLAT-01 | A platform session gets nothing from any org action, page or route. | ORG-01's discovery (every `'use server'` export, `harness.ts`), called with a platform principal instead of none: every one refuses and the write spy (`write-spy.ts`) records nothing. Plus a unit check: `can()` over every `Permission` for an `Actor` built from a platform principal returns `no_permission`. |
| PLAT-02 | Every platform page, layout, route handler and action guards first with `requirePlatform`, and refuses an org staff session and an anonymous one. | ORG-05's `unguardedEntrypoints()` extended with the platform guard names; a `platform.manifest.ts` lists each platform action and its permission, and the suite fails on a missing or stale entry. |
| PLAT-03 | Platform code reads only the allowlist. | The Prisma query spy over every platform page and action: touched models ⊆ {`Organization`, `OrgHealth`, `OrgIntegration` (status columns), `OrgInvite`, `SupportAccessGrant`, `PlatformAdmin`, `PlatformCredential`, `PlatformRole`, `PlatformRoleAssignment`, `AuditLog`, `JurisdictionRule`, owner-contact reads of `OrgMembership`/`StaffAssignment`/`StaffUser` selecting name and email only}. |
| PLAT-04 | Every platform write is audited atomically. | Each platform action run once: ≥ 1 `AuditLog` row with `actorType: PLATFORM`, inside the same transaction (a forced failure after the audit leaves neither). |
| PLAT-05 | A grant admits nothing unless live. | Pending, denied, revoked, expired (clock moved), admin deactivated: the support session's next request fails `principalIsStillValid`. |
| PLAT-06 | Under a live grant every write is refused. | ORG-02's manifest driven as the support actor **on the grant's own org's ids**: no writes, every money action's `checkMonetaryAuthority` outcome is `denied` / no permission, `staff.manage`, `confidential.read`, `accesscode.reveal` refused. Own-org reads succeed (sanity, as ORG-02 has). |
| PLAT-07 | Every audit row written during a support session carries `supportGrantId` and `actorType: PLATFORM`. | Spy on `auditLog.create` across PLAT-06's run (meaningful once OQ-27 allows any write; until then it covers the grant's own lifecycle rows). |
| PLAT-08 | The database refuses what the rules refuse. | Direct SQL: delete a grant; break-glass of 61 min; approval by a non-owner or a removed member; org-less non-PLATFORM audit row; revoking the last platform owner; deleting an admin. Each fails. |
| PLAT-09 | Sessions do not cross hosts. | A platform cookie on an org host, an org cookie on `PLATFORM_HOST`, a support session or entry token from org A's grant on org B's host: each refused. |
| PLAT-10 | Break-glass notifies every active owner and shows the banner. | Two owners, one removed member: two `Notification` rows on `support_access`, none for the removed member; banner until acknowledged. |

Every check gets a **control** (a deliberately broken case it must flag), as `tests/invariants/controls/` does for ORG-01..08.

### 7.2 Unit and e2e

- Unit: `canPlatform` truth table; `platformRevokeRefusal` with the list as a value; catalogue disjointness; seed roles ⊆ catalogue; `loadSupportActor` output (no write permission, ceilings 0); step-up window edges; `OrgHealth` writer output carries no string longer than a state code.
- e2e (`PLATFORM_HOST=platform.localhost`): sign-in with TOTP (the spec computes codes from the seeded secret), enrolment, step-up, create org + invite, request → owner approves on the org host → enter → banner → end; break-glass → owner notification row → banner → "Seen". `uniqueClientHeaders()` on every context (rate-limit trap). Both `desktop-chrome` and `mobile-chrome` for every new screen.

## M. Migration inventory — every place that must change

| Finding | Where | Row |
|---|---|---|
| `Principal.kind` lacks `platform`, `support` | `apps/web/auth.ts:42-57, 283-316` | R-294, R-295 |
| `principalIsStillValid` has no platform or support branch | `lib/auth/org.ts:53-87` | R-294, R-295 |
| `hostOrgId` must return `null` for `PLATFORM_HOST` | `lib/auth/org.ts:38-45` | R-294 |
| `/platform/**` must 404 off `PLATFORM_HOST`; non-platform paths 404 on it | `apps/web/proxy.ts:90-124`; `app/public-routes.ts` | R-294 |
| `currentActor` default branch loads a tenant actor for any unknown kind | `lib/auth/actor.ts:215-231` | R-295 (explicit cases; unknown → null) |
| `requireStaff` admits only `staff` | `lib/auth/guard.ts:61-65` | R-295 |
| `Actor.kind` union | `packages/core/rbac/can.ts:35` | R-295 |
| `currentAuditActor` maps every non-staff to `TENANT` | `lib/audit/index.ts:22-46` | R-294 |
| `AuditLog.orgId` default `org_0`; no `supportGrantId`; `ActorType` has no `PLATFORM` | `schema.prisma:443-451, 7278-7303` | R-294 |
| `recordAudit` stamps org only when given | `packages/core/audit/record.ts:107`; `lib/audit/index.ts:58-62` | R-294 |
| No step-up helper; `authenticatedAt` not in session | `apps/web/auth.ts:293`; `lib/auth/guard.ts:84-105` | R-294 |
| No platform rate limit | `packages/core/auth/rate-limit.ts:31-51` | R-294 |
| `sealSecret` purpose for platform MFA | `packages/core/auth/secret-box.ts:37` | R-294 |
| New `AuthTokenPurpose` values | `schema.prisma:4336` | R-294, R-295 |
| No platform catalogue or roles | `packages/core/rbac/permissions.ts`; new `platform.ts` | R-302 |
| `ORG_LESS` allowlist | `tests/invariants/org-01-05-06.test.ts:77-85` | R-294, R-302 |
| ORG-05 guard list | `tests/invariants/harness.ts` (`unguardedEntrypoints`) | R-294 |
| Cron children write no health summary | `lib/cron/per-org.ts:53-151` | R-303 |
| `jobHealth`, `deadLetteredEvents` are the counts `OrgHealth` stores | `lib/jobs/queries.ts:66-104`; `lib/jobs/outbox.ts:196` | R-303 |
| Kill switch flipped by SQL | `schema.prisma:495`; D-347 | R-306 |
| `jurisdiction.write` in the org catalogue; owner holds it | `permissions.ts:78-79, 268` | R-305 |
| `/jurisdiction` "New version" and `/jurisdiction/new` | `app/(admin)/jurisdiction/page.tsx:55`; `app/(admin)/jurisdiction/new/page.tsx:20` | R-305 |
| `createRuleVersion` guarded by an org permission, audited into org #0 | `lib/jurisdiction/actions.ts:183, 292` | R-305 |
| Manifest entry for `createRuleVersion` moves to `platform.manifest.ts` | `tests/invariants/actions.manifest.ts:170-171` | R-305 |
| No `OrgInvite`; owners bootstrapped by script | `packages/db/prisma/create-owner.mts`; PRD 10 §1.2 | R-304 |
| No `support_access` category | `packages/core/notifications/categories.ts:31-149, 262-277` | R-295 |
| No org audit page | `audit.read` (`permissions.ts:64`) gates no route | R-295 |
| `deliverOverChannel` holds every send for a switched-off org | D-347 | R-295 (per OQ-28) |
| `lib/portal/guard.ts` comment promises staff impersonation | `lib/portal/guard.ts:25` | R-295 (comment corrected: support grants, staff never) |
| No `create-platform-admin` script | `packages/db/prisma/`; root `package.json` | R-294 |

## 8. Backlog rows, decisions, open questions

**Placement: appended to Milestone 19, not a new milestone.** R-291, R-292, R-294, R-295, R-296 and R-300 already live there and each assumes the console; a separate milestone would put the console in one place and its every caller in another. PRD 10 also reserves "Milestone 20" for archiving append-only rows, which this does not touch.

| ID | Item | Size | Depends on |
|---|---|---|---|
| R-294 (refined) | Platform principal and identity: `PLATFORM_HOST`, `PlatformAdmin`/`PlatformCredential`, second Auth.js instance with `__Host-` cookies, mandatory TOTP, step-up, lockout and limits, `db:create-platform-admin`, `ActorType.PLATFORM` + `AuditLog` columns and CHECKs, `audit()` org fill, `currentAuditActor` branches; `/platform/login`, `/enrol-mfa`, `/step-up`, `/account`; PLAT-02 (guard), PLAT-08 (audit part), PLAT-09 (platform half) | L | R-288, R-289 |
| R-302 | Platform roles and permissions: catalogue, `canPlatform`, seeded roles, assignments, last-owner function + trigger; `/platform/admins`; PLAT-08 (roles) | M | R-294 |
| R-303 | Org console, read side: `OrgHealth` written by every cron child; `/platform`, `/platform/orgs`, `/platform/orgs/[slug]` (no lifecycle actions yet), `/platform/audit`, `/platform/jobs` incl. cron re-trigger, `/platform/settings`; PLAT-01, PLAT-03 | M | R-302, R-290a; integration panel reads R-275 |
| R-304 | Create organisation and invite its owner: `OrgInvite`, `/platform/orgs/new`, `/invite/[token]`, resend/revoke; org configure (name, slug pre-go-live, colours) | M | R-303 |
| R-305 | Jurisdiction library moves to the platform: `jurisdiction.publish`, `/platform/jurisdiction`, org `/jurisdiction` read-only, `jurisdiction.write` removed from the org catalogue, owner notifications on publish | M | R-302; before R-291 |
| R-306 | Per-org notification kill switch in the console (step-up, reason, audited) | S | R-303 |
| R-295 (refined) | Support access: `SupportAccessGrant` + triggers, request / break-glass / entry token / support session / read-only support actor / banner / end; org `/settings/support-access` and `/settings/audit`; `support_access` category; PLAT-05, 06, 07, 09, 10 | L | R-303 |

**Order:** R-275 (next, unchanged) → R-294 → R-302 → R-303 → R-304 → R-306 → R-305 → R-292, R-293 → R-277 → R-295 → R-276 → R-291 → … as PRD 10. Identity moves ahead of the integration rows because R-292 ("from the platform console"), R-291 (console half of the checklist), R-296 (fee field) and R-290b ("flipped by SQL until R-294") all need it, and it depends on nothing unbuilt.

**Decisions proposed** (D-349–D-357, awaiting Shane): platform permissions are a separate catalogue with no bypass (D-349); `PLATFORM_HOST` and an isolated platform session (D-350); platform roles as rows, last owner protected, bootstrap discipline (D-351); `AuditLog` platform rows and the `org_0` default dropped (D-352); support grants read-only, built from the grant row (D-353); `OrgHealth` written by each org's cron child, console reads an allowlist (D-354); jurisdiction rules are platform-published (D-355); the platform re-triggers a cron child, never a `JobRun` (D-356); no two-person rule in v1 (D-357).

**Open questions** (OQ-27–OQ-30): read-only vs read-and-fix support grants (OQ-27); break-glass while the org's notifications are off (OQ-28); who the platform admins are at launch, and is script-based recovery acceptable (OQ-29); may an org opt out of break-glass (OQ-30).

**Not given rows, on purpose:** per-view read auditing (OQ-27); platform-to-platform notifications beyond lockout; staff impersonation of tenants (never — support sees the staff side only); platform billing beyond the fee field (D-322); self-serve signup (D-323); IP allowlisting of `PLATFORM_HOST` (a Vercel firewall rule, not code, when there is a fixed office).

---

*This document contains no legal advice. Support access to an organisation's tenant data may be governed by the customer agreement and state privacy law; the grant reasons, notification wording and break-glass terms need review by counsel before a real customer is onboarded. This is a learning project.*
