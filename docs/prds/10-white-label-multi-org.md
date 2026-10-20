# 10 — White-Label Multi-Org PRD
## Organisation as the tenant root, per-org Stripe/Twilio/branding, provisioning, platform admin, data exit

| | |
|---|---|
| **Document status** | Draft v0.1 — reviewed against the code (every "today" claim below cites a file), nothing in it is built |
| **Date** | October 20, 2026 |
| **Prepared by** | Shane LaBounty (brief) · Claude (code audit and spec) |
| **Source** | Shane's brief of 2026-10-20: "multi-org from day one; Tim Bales's group (20 rentals) is org #1" |
| **Companion files** | `00-master-prd.md` · `08-messaging-and-white-label.md` (§8 is the sketch this document replaces) · `09-quickbooks-sync.md` · `06-backlog.md` Milestone 19 · `07-decisions.md` (**overrides this document where they conflict**) · `../PROGRESS.md` |

> **Answered 2026-10-20, after Shane read this document:** D-315 and D-316 confirmed as written. OQ-23 → D-322 (application fee only; §6's meter and platform customer are not built), OQ-24 → D-323 (platform admin creates orgs), OQ-25 → D-324 (neutral product domain, not yet bought), OQ-26 → D-325 (90 days / 7 years, counsel later). The sections below still describe the options as they were weighed.

> **On the numbering.** The brief said "backlog IDs start at R-121; decisions continue from D-14". Those are the draft numbers PRD 08 and 09 carried, and D-309 already records why they collide (R-098–R-121 are built, D-11–D-16 settled). The real ones: **Milestone 19, R-285–R-301**, decisions **D-315–D-320**, open questions **OQ-23–OQ-26**. Six Milestone 18 rows already name this work (R-272–R-278); they are not duplicated here, they are refined in place and un-gated where a decision below answers their gate.

> **Conflicts with settled decisions, and with the brief — resolve before any row is built.**
> - **The brief's "keep the existing ledger-driven PaymentIntents" describes D-2, which D-11 superseded in July.** What exists is Stripe **Billing**: one Customer and one Subscription per `LeasePayer`, invoices drive rent, core pushes every jurisdiction-dependent amount as an invoice item (D-11, D-12), and there is no PaymentIntent code path for rent at all (`apps/web/lib/billing/stripe-adapter.ts`). Stripe Connect therefore has to carry Billing objects, not PaymentIntents: §2 designs it that way, and D-316 records it.
> - **OQ-18 ("multi-tenant on one deployment — go?") is answered by the brief**: D-315.
> - **OQ-19 ("Stripe Connect per org — supersede D-11/D-12?") is answered by the brief**, but D-11 and D-12 survive it: Stripe stays the record and core still decides every number, per connected account. D-316 narrows them rather than replacing them.
> - **D-5 (no superuser, no bypass in `can()`) is kept, not amended.** The brief's super-admin is a different principal kind with zero org permissions, and support access is a grant row, never a session swap (D-320).
> - **D-123's one-LLC-per-property shape is unchanged.** `Organization` sits *above* `LegalEntity`; nothing about entity scoping moves.
> - **An org cannot be deleted** the way the saas-foundation deletes one (`onDelete: Cascade`): `LedgerEntry`, `AuditLog`, `Message` and `Notification` refuse UPDATE and DELETE by trigger (CLAUDE.md → *Invariants the database enforces*). Offboarding is export + freeze + retention purge (D-319).

## 0. What exists, what the brief assumed, and the gap (2026-10-20 audit)

The platform is single-org by construction: the tenancy root is `LegalEntity` (`packages/db/prisma/schema.prisma:457`), staff are scoped to properties and entities (`StaffAssignment`, `:3851`), and **`null`/`null` on an assignment means "everything in the database"** (`packages/core/rbac/can.ts:227-249`, `apps/web/lib/auth/scope.ts` returns `{}` for `everything`). That one primitive is the whole problem: under two orgs, every owner is a cross-org superuser and every `propertyWhere`-guarded list (about 170 files, 7,100 reads) returns the other org's rows. Everything else in §M is a consequence or a sibling of it.

| Area (brief §) | Today | Gap | Rows |
|---|---|---|---|
| 1 Tenancy | No `Organization`. 112 models; 36 carry `propertyId`, 3 carry `legalEntityId`, ~50 reach a property through a parent, **21 are global** (§M1). | Org root, `orgId` on every org-owned table, per-org uniqueness, a scope that cannot widen past the org, a cross-org test harness | R-274, R-285, R-286, R-287, R-288 |
| 2 Payments | One `STRIPE_SECRET_KEY`, one webhook secret, no `Stripe-Account` header, no application fee anywhere (`lib/billing/stripe-adapter.ts:53,108-190`; `app/api/webhooks/stripe/route.ts:27`). All rent and application fees land on one account. | Connect Standard per org, Billing objects on the connected account, Connect webhook, per-account idempotency and reconciliation | R-277 |
| 3 SMS | One Twilio account + messaging service (`lib/notifications/live-adapter.ts:48-60`); inbound verified against one token and routed by phone globally (`app/api/sms/inbound/route.ts:44,57`; `lib/comms/threads.ts:112,153`); `SmsOptOut.phone @unique` (`schema.prisma:6694`). | Subaccount per org, number per org, 10DLC brand + campaign as onboarding steps with status, routing by `To`, opt-out and consent per org | R-275, R-292, R-272, R-273 |
| 4 Branding | `metadata.title` fixed (`app/layout.tsx:14-16`), `COMPANY_NAME = 'Rental Operations'` (`lib/comms/template-values.ts:56`), one `AUTH_URL`, `NEXT_PUBLIC_*` baked at build. | Host → org, subdomain per org, runtime brand, custom domain later | R-289, R-276, R-293 |
| 5 Provisioning | `db:create-owner` counts owners across the whole database and refuses a second (`packages/db/prisma/create-owner.mts:86-91`). No invite-to-org flow. | Org creation, owner invite, checklist with derived status | R-288, R-291, R-301 |
| 6 Platform billing | Nothing. The platform has no Stripe customer concept of its own. | Model is open (OQ-23); meter and subscription on the platform's own Stripe account once decided | R-296 |
| 7 Compliance | Decision + reason + FCRA notice exist (`lib/screening/staff-actions.ts:57`, R-060/R-061); reason list is R-269 (gated on OQ-16). `ScreeningCriteria.version` is global (`:1427`). `JurisdictionRule` is per state, no org dimension (`:6594`; `lib/jurisdiction/queries.ts:39`). | Per-org reason list mapped to written criteria, per-org criteria versions, per-org enabled states, stricter-only policy overrides | R-297, R-298, R-278 |
| 8 Data exit | Per-property exports exist (rent roll, settlement, tax, packets, transcripts — `app/api/reports/*`, `lib/*/packet.ts`). No org-wide export, no offboarding, no purge; `packages/core/documents/retention.ts` is document-only. | One org export, offboarding state machine, retention | R-299, R-300 |
| 9 Platform admin | None (`create-owner.mts` says so; D-5). `lib/portal/guard.ts:25` mentions impersonation; nothing implements it. `AuditLog` has no org or acted-as column (`:6602`). | Platform principal, org console, time-boxed audited support access | R-294, R-295 |

**What PRD 08 §8 got right and this document keeps:** multi-tenant on one deployment, not forks; each org brings its own Stripe and Twilio; `OrgIntegration` holds credentials encrypted at rest; branding is data. **What it got wrong:** "Prisma middleware enforces it" — a middleware that injects `orgId` cannot see a query whose `where` already names another org's id, which is exactly the IDOR class the foundation's INV-02/03 exist for; §1 uses a scope the actor cannot widen plus a harness, and RLS as the backstop.

## 1. Tenancy — isolation in schema, auth and every query

**Goal.** A row belongs to exactly one organisation, an actor's scope can never exceed their organisation, and a test proves both for every action and route without each one registering itself.

### 1.1 The saas-foundation's tenancy, evaluated for reuse

The foundation (`~/Projects/saas foundation`, v1.3.0) ships `Org` / `Membership(orgId, userId, role)` / `Invite` / `AuditEvent(orgId?)` (`prisma/schema/core.prisma:76-170`), a guard-first rule (`requireOrg(slug, perm)` is the first statement of every page, action and route; `src/core/authz/guards.ts:22`), an `inOrg(ctx)` spread for every `where` (rule 2, including secondary ids, rule 3), `orgAction()` wrappers that carry a zod schema whose id fields are tagged `ref('<model>')`, and a harness (`tests/invariants/inv-01-04-22-actions.test.ts`) that **discovers every `'use server'` export by glob**, calls it anonymously (INV-01), as org A with org B's ids (INV-02), with a secondary id swapped (INV-03), and asserts a cross-org id and a nonexistent id get **byte-identical** responses (INV-04). Org lifecycle rules: at least one owner (INV-21), MFA enforced by the guard not the layout (INV-22), fresh sign-in for delete (INV-26), only an owner grants owner (INV-28).

| Foundation piece | Verdict | Why |
|---|---|---|
| `Org`, `Membership`, `Invite` shape | **Reuse** (as `Organization`, `OrgMembership`, `OrgInvite`) | Same problem, already proven; invites hashed, 7-day expiry, single use, email must match. |
| Guard-first rule and the entrypoint linter (`unguardedEntrypoints()`) | **Reuse** | The rental repo already has the rule informally (`requireScope` on every list, D-110); the linter makes it a test. |
| `inOrg()` spread convention | **Adapt** | The rental repo's equivalent is `propertyWhere(scope)`. The change is inside that one function (§1.3), not at 7,100 call sites. |
| `orgAction()` / `userAction()` wrappers with `ref()`-tagged schemas | **Do not adopt** | 257 `'use server'` exports in 94 files take `(previous, formData)` and parse by hand. Rewrapping them is a rewrite that buys nothing the harness needs; the harness gets its id tagging from a per-action manifest instead (§1.5). |
| `Role` enum (owner / admin / member / scorekeeper) | **Do not adopt** | The rental repo's roles are data (`Role` table, `permissions String[]`, `:3815`) with property and entity scope. Richer, and D-5 depends on it. |
| INV-01..04 harness | **Port** | The only part that matters. Driven by discovery, so Milestone 18–19 rows cannot forget to register. |
| `deleteOrg` with cascade | **Do not adopt** | Append-only triggers refuse the cascade (D-319). |
| `BillingAccount(orgId → stripeCustomerId, stripeSubscriptionId)` | **Reuse for platform billing** (R-296) | The org is the platform's customer; this is exactly that table. |

### 1.2 Schema

```
Organization        id, slug @unique, name, status (ACTIVE | FROZEN | OFFBOARDED),
                    brand Json?, timezoneDefault, createdAt, frozenAt?, offboardedAt?
OrgMembership       orgId, staffUserId, @@id([orgId, staffUserId]); joinedAt, removedAt?
OrgInvite           orgId, email, roleId, tokenHash @unique, expiresAt, acceptedAt?, revokedAt?, invitedByStaffId
OrgIntegration      orgId, provider (STRIPE | TWILIO | RESEND | QUICKBOOKS | ESIGN …), status,
                    config Json (non-secret: account ids, numbers, domains), secret Bytes? (sealed),
                    @@unique([orgId, provider])                                 ← R-275, unchanged
```

**`orgId` goes on every org-owned table, including the ones that already reach an org through `propertyId`.** Not only the 21 global ones. Reason: the harness and RLS (§1.6) both need the column on the row they are checking, and a join to `Property` to find the org is the thing an unscoped `where` skips. `LegalEntity.orgId` is required; `Property.orgId` is required and a trigger asserts it equals its entity's (hand-written SQL, as every invariant here is). Backfill: one migration creates org #0 from the existing portfolio and stamps every row (R-285).

**Identity.** `StaffUser` stays one row per human, email still `@unique` (`:2010`): a person is a member of one or more orgs through `OrgMembership`, and every `StaffAssignment` gains `orgId` (required, must match a live membership — trigger). This is the foundation's model and it is what lets one bookkeeper serve two groups. **Tenants, guarantors and vendors are per-org rows** — a renter who moves between two customers' portfolios is two `Tenant` rows, because their lease, ledger, consent and opt-out are facts about that org's relationship, not about the person (D-318). `Tenant.email` and `.phone` stay non-unique; the per-org lookups in §1.4 make them unambiguous.

**Uniques that move from global to per-org** (each is a collision or a leak today; §M1): `SmsOptOut(orgId, phone)`, `ScreeningCriteria(orgId, version)`, `InspectionTemplate(orgId, defaultForType)`, `MessageTemplate`/`Audience`/`DocumentTemplate`/`PreventiveMaintenanceTemplate` gain `orgId` with their name indexes per org, `LeasePayer.stripeCustomerId` and `.stripeSubscriptionId`, `Payment.stripePaymentIntentId`, `PaymentInvoiceSplit(paymentId, stripeInvoiceId)` and `ProcessedStripeEvent` become `(orgId, …)` — Stripe ids are unique per account, not globally (§2.4). `SmartLock(provider, externalId)` and `LeaseEnvelope.providerId` likewise. `Role.key` stays global for the seeded system roles; a per-org custom role is out of scope (ROLE-07 remains where it is).

**Rows that belong to no org** and stay that way: `JurisdictionRule` (a statute is not per org, D-4; what is per org is in §7), `Role` (system rows), `RateLimitCounter` (keys gain an org component, §1.4), `AuthToken` (points at a subject that has an org), `UnroutedMessage` gains `orgId` because routing by `To` (§3) always knows the org even when it does not know the sender.

### 1.3 Scope — the one primitive

`PropertyScope` gains the org:

```ts
type PropertyScope =
  | { orgId: string; everything: true }                      // everything IN THIS ORG
  | { orgId: string; everything: false; legalEntityIds: string[]; propertyIds: string[] }
```

`propertyScope(actor, permission)` is computed **for the org the session is in** (§1.4), from assignments whose `orgId` matches. `propertyWhere(scope)` returns `{ orgId }` for `everything`, never `{}`; `tenantWhere` and `scopedByProperty` follow. That single edit closes the "null/null is a cross-org superuser" hole for every one of the ~170 files that already go through it (`apps/web/lib/auth/scope.ts`; `lib/scope/current-scope.ts:53`). What it does not close is the list of queries that never went through it — §M3 names them, R-285 fixes them, and the harness (§1.5) is what proves the list is complete.

`Actor` gains `orgId` (the active org) and `memberships: { orgId, slug, name }[]`. D-5 holds: there is still no `isSuperuser`, and `everything: true` is an ordinary owner assignment with `propertyId = null`, `legalEntityId = null` — now bounded by `orgId`.

### 1.4 Auth and session

- **Sign-in resolves the org from the host first** (§4: `<slug>.<base>` or a custom domain), then the user. `lib/auth/actions.ts:110` (`staffUser.findUnique({ email })`) stays a global identity lookup, and the session is only created if the user has a live membership in the host's org; otherwise the response is the same as a wrong password. A user with memberships in several orgs switches by host, not by a cookie: the org is in the URL, so a link pasted into a ticket cannot open the wrong org.
- **The session carries `orgId`** (`auth.ts` `Principal`, `:41-48`); `currentActor` builds assignments from that org only. Changing membership takes effect on the next request (foundation INV-05): membership is read per request, as it already is for assignments.
- **Tenant and guarantor magic links** resolve the org from the host, then `findFirst({ orgId, email })`. Today's `findFirst({ email, active: true })` with no uniqueness (`lib/auth/actions.ts:464`) is a wrong-org login the moment two orgs share a renter's email — the one finding in §M that is a security defect on day one of org #2, so it is in R-288, not later.
- **Rate-limit keys gain the org** (`login:staff:${orgId}:${ip}` etc.; `lib/auth/actions.ts:107,333,493,535`), so one org's abuse or shared office IP cannot exhaust another's budget.
- **Platform-wide sign-in** (`/platform`) is a different principal kind (§9) and never resolves an org from the host.
- **Vendor links** (`VENDOR_WORK_ORDER`, `VENDOR_BID`) are scoped to a work order and therefore to one org already; they only need the org's host and brand on the page (§4).

### 1.5 Cross-org tests — ported from the foundation, adapted to this repo's actions

`tests/invariants/` here mirrors the foundation's, with the rental repo's fixtures: two orgs, each with an owner, a manager, an entity, a property, a unit, a lease, a tenant, a vendor, a template, an audience, a ticket, a work order, a payment plan — one row of every org-owned model that an action can name by id.

| ID | Invariant | Mechanism |
|---|---|---|
| ORG-01 | Every `'use server'` export rejects an anonymous caller and writes nothing. | Glob `apps/web/**` for `'use server'` modules (94 today), import each, call every export with no session. |
| ORG-02 | Org A's owner cannot read or mutate an org-B row by id through any action, page or route handler. | Same discovery. Each action's id-shaped form fields are swapped for org-B ids; expected: `notFound`/refusal and org B unchanged. Id tagging comes from **a manifest** (`tests/invariants/actions.manifest.ts`: export name → `{ field: model }`), not from zod meta, because these actions parse `FormData` by hand. An untagged id-like field name fails the harness, as the foundation's does. |
| ORG-03 | Secondary ids (a `vendorIds[]` on an approval, a `leaseIds[]` on an announcement) from org B are dropped or refused. | Same swap, on every list field. `lib/workorders/approvals.ts:461` accepts any vendor id from form data today. |
| ORG-04 | A cross-org id and a nonexistent id get byte-identical responses. | Catches data echoed before authz. This is also ROLE-01's existing 404-not-403 rule, generalised. |
| ORG-05 | Every page, layout and route handler guards first, or carries a `// public: <reason>` marker. | Foundation's `unguardedEntrypoints()` over 23 route handlers and every `page.tsx`. |
| ORG-06 | Every org-owned model has `orgId NOT NULL` and (where RLS is on) a policy. | Schema test over `schema.prisma` against an allowlist of the org-less tables in §1.2. |
| ORG-07 | A null/null assignment in org A lists nothing from org B. | Direct test of `propertyWhere`, `tenantWhere`, `scopedByProperty`, `currentScope`. |
| ORG-08 | Every cron and sweep run as org A touches no org-B row. | Two-org fixture, run `/api/cron` with a spy on writes. |

The harness is **the gate for Milestone 19** the way the foundation makes INV-* the gate for every clone: ORG-01..08 pass before R-277 or R-292 start, and a row that adds an action adds its manifest line or the suite fails.

### 1.6 Row-level security — the backstop, not the primary

Postgres RLS on every org-owned table (`USING (org_id = current_setting('app.org_id', true)::text)`), set per transaction by a Prisma client extension that wraps each query in `$transaction` with `set_config('app.org_id', $1, true)`. Cost: every query becomes a transaction (the Neon pooler is transaction-mode, so it works, but it is a round trip), and the cron, webhooks and the platform console need a `BYPASSRLS`-equivalent context that is itself audited. **Decision (D-317): the column + scope + harness is the enforcement; RLS is defense-in-depth, built after the harness is green (R-287, Should), never instead of it.** An RLS policy silently returns zero rows for a bug the harness would have named.

## 2. Payments — Stripe Connect Standard per organisation

**Goal.** Each organisation owns its Stripe account, rent settles to that org's bank, the platform never holds customer funds, and the platform can take a fee as an application fee once OQ-23 decides whether it does.

### 2.1 Why Standard, and what it means for Billing

Standard: the org completes Stripe's own onboarding, gets the full Stripe dashboard, and is the merchant of record — disputes, refunds and payouts are theirs, which is the right liability line for a white-label customer who already banks their rent. Express would make the platform the support desk for payouts; Custom would make it the merchant.

With Standard accounts the platform makes **direct charges**: every Billing object this repo already creates — Customer, Price, Subscription, SetupIntent, invoice items (`lib/billing/stripe-adapter.ts:124-190`) — is created **on the connected account** by adding one header, `Stripe-Account: acct_…`, to the adapter's `fetch`. D-11 and D-12 survive intact per account: Stripe is still the record and core still computes every jurisdiction-dependent amount and pushes it as an invoice item. The platform fee is `application_fee_percent` on the Subscription (or `application_fee_amount` on a one-off invoice), which Stripe deducts before payout and reports as a transfer to the platform account — a fact the ledger projection records as a platform-fee line, not as rent (D-316).

**What the brief called "ledger-driven PaymentIntents" does not exist and is not reintroduced.** Application fees collected at `apply/[token]` (`lib/applications/fee-webhook.ts`) are the one PaymentIntent path today; they move to the connected account the same way.

### 2.2 Onboarding

`OrgIntegration(provider: STRIPE)` holds `config.accountId` and `status: NOT_STARTED | ONBOARDING | RESTRICTED | ENABLED | DISABLED`. The settings page creates the account (`POST /v1/accounts`, type `standard`), opens an Account Link (`account_onboarding`), and the `account.updated` webhook moves the status from `charges_enabled` / `payouts_enabled` / `requirements.currently_due`. Rent collection for an org is refused (a Task for the owner, not a silent skip) while status is not `ENABLED`, which is the per-org form of D-26's "no live key until …" posture.

### 2.3 Client side

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` stays one value: for direct charges on a Standard account the browser uses the **platform's** publishable key with `loadStripe(pk, { stripeAccount })`. The account id is a runtime prop on `/portal/pay` and `/apply/[token]` (`app/portal/(signed-in)/pay/page.tsx:140`, `app/apply/[token]/page.tsx:138`), read from the org, not from `NEXT_PUBLIC_*`.

### 2.4 Webhooks, idempotency, reconciliation

- One **Connect webhook endpoint** (`/api/webhooks/stripe/connect`) with one signing secret, receiving events for every connected account; `event.account` names the org. The existing endpoint keeps serving the platform account (for R-296's platform billing). `app/api/webhooks/stripe/route.ts:27`.
- `ProcessedStripeEvent` is keyed `(orgId, stripeEventId)` — Stripe event ids are unique per account, and D-24's claim-before-project insert keeps working with the composite key.
- `leasePayer.findFirst({ stripeCustomerId })` (`lib/billing/webhook.ts:179`) becomes `({ orgId, stripeCustomerId })`; the `@@unique`s in §1.2 make a cross-account clash impossible to misroute.
- `reconcileLedger` (`lib/ledger/reconcile.ts`) runs **per org** inside the cron (§5 of R-290): one org's drift is one org's Task. D-25's limits are unchanged.
- **Payouts are not modelled** (they are the org's, visible in their Stripe dashboard); the ledger projection gains one entry kind, `PLATFORM_FEE`, posted from `application_fee.created` so an owner statement shows gross rent, platform fee, net.
- The org can disconnect (deauthorise) from their Stripe dashboard: `account.application.deauthorized` sets status `DISABLED`, raises an owner Task, and freezes collection. Nothing is deleted.

## 3. SMS — Twilio subaccount, A2P 10DLC, TCPA, per organisation

**Goal.** Each org texts from its own number, registered under its own brand and campaign, with consent and opt-out that belong to that org.

### 3.1 Provisioning (R-292, replaces today's single-account D-15 gate with a per-org one)

The platform's Twilio account is the parent. Per org, from the platform console or the org's setup checklist:

1. Create a **subaccount** (`POST /2010-04-01/Accounts`), store `config.accountSid`, seal the subaccount auth token into `OrgIntegration.secret` (R-275's sealed store).
2. Buy or port a **number** in the org's area code; create a **Messaging Service** on the subaccount; attach the number.
3. **A2P 10DLC**: create the Trust Hub customer profile, then the **brand** (the org's legal name, EIN, address, contact), then the **campaign** (use case "mixed" or "customer care"; sample messages drawn from the org's templates; opt-in description from §3.3). Each is a status the org can see: `PENDING | IN_REVIEW | APPROVED | FAILED`, polled nightly and on demand, with Twilio's failure reason shown verbatim. Brand vetting is days; campaign review is days to weeks — the checklist shows "started N days ago". **Sending to anyone but the org owner's own verified number is refused until the campaign is `APPROVED`** — the US carriers block unregistered 10DLC traffic anyway, and an unexplained carrier block looks exactly like a product bug.
4. Status callback and inbound webhooks point at the org's host (§4), so Twilio's signature — computed with the **subaccount's** token over the exact URL — verifies against the right secret: the inbound route looks the org up by `To` (the number) **before** verifying, since it cannot know which token to verify with otherwise (`app/api/sms/inbound/route.ts:44`).

### 3.2 Routing

Inbound: `To` → number → org; then `candidatesForPhone` runs **within the org** (`lib/comms/threads.ts:153`). Today's AMBIGUOUS-on-two-orgs becomes impossible, and an unknown sender becomes an `UnroutedMessage` **in that org's queue**, visible to that org's `everything` actors rather than to a global one (`lib/comms/queries.ts:113`). R-263's reply-Task and R-266's settings page then have an org to hang off.

### 3.3 TCPA — consent and opt-out per org

- **Opt-in** is the existing `TenantConsent` (R-051b, D-49) — a per-org row by construction once `Tenant` is per org. The lease addendum and portal consent text name the org's brand and number. The campaign registration's opt-in description quotes the same text, so what the carrier approved is what the renter saw.
- **Opt-out** is `SmsOptOut(orgId, phone)`. Today `phone @unique` makes STOP to org A's number silence org B's messages to the same person (`:6694`; `lib/comms/opt-out-store.ts`). STOP/START/HELP keyword handling (R-040e, D-162) is unchanged otherwise; the confirmation text names the org.
- **Footer** ("Reply STOP to opt out", business name) is per org (R-266's settings page gains the org as its row key).
- **Quiet hours** stay property-local (D-3); the per-property setting R-266 adds is unchanged. Nothing here is per org except the default for a new property.

## 4. Branding — logo, colours, sender name, subdomain

- **Host → org** is the first thing `proxy.ts` does: `<slug>.<base>` (default `rent.labintelligence.co`, see OQ-25) or a verified custom domain (R-276, later) → `Organization`; the org is attached to the request and read by auth (§1.4), by every link builder that uses `AUTH_URL` today (`lib/workorders/actions.ts:421`; `lib/auth/delivery.ts:136`; `app/api/sms/*:34-37`), and by Twilio's signature URL (§3.1). The bare base host serves the platform console and a neutral landing page. A wildcard DNS record and a wildcard certificate on Vercel cover the subdomains.
- **Brand is runtime data** (`Organization.brand`: `name`, `logoDocumentId`, `colorPrimary`, `colorAccent`, `supportEmail`, `supportPhone`, `senderName`), rendered as CSS custom properties on `<html>` over the existing Homestead tokens (D-163) — a palette swap, not a theme engine. `metadata.title`, the PWA manifest and icon, every "Rental Operations" string (about 30 pages), `COMPANY_NAME` and `company.phone` (`lib/comms/template-values.ts:56,139,145` — the latter is `null` today, so any template using it refuses to send) read from it. `NEXT_PUBLIC_OPERATIONS_PHONE` becomes `brand.supportPhone`.
- **Sender name** is the Resend `from` display name and the SMS footer business name; the Resend sending domain per org is R-293 (a verified subdomain of the org's custom domain, or the platform's shared domain with the org's display name until they have one).
- **Custom domain** stays R-276 and stays later: it needs the org to own DNS, a Vercel domain per org, and a cookie/`AUTH_URL` per domain, none of which org #1 needs on day one.

## 5. Provisioning — org signup to go-live, with a checklist

**Who creates an org** is OQ-24; the default is the platform admin (§9) from the console, which then emails the owner an `OrgInvite`. Self-serve signup is a later row once there is a second prospect.

The checklist lives on the org side at `/settings/setup` and on the platform side on the org's console page. **Status is derived from facts, not from a steps table**, except where the fact lives outside (10DLC, Stripe onboarding), which `OrgIntegration.status` already holds:

| Step | Done when | Owner |
|---|---|---|
| 1 Organisation created, owner invited and accepted | `OrgMembership` with an owner assignment exists | Platform |
| 2 Users and roles | ≥ 1 non-owner member, or the owner marks "just me" | Org |
| 3 Entities and properties | ≥ 1 `LegalEntity` and ≥ 1 `Property` with state and timezone | Org (CSV import, R-168) |
| 4 Templates reviewed | every managed template the org will use has been opened and saved once, or marked reviewed | Org |
| 5 Stripe connected | `OrgIntegration(STRIPE).status = ENABLED` | Org (hosted onboarding) |
| 6 Twilio provisioned, 10DLC approved | subaccount + number + campaign `APPROVED` | Platform starts, carrier finishes |
| 7 Email domain verified | `OrgIntegration(RESEND).status = VERIFIED`, or shared domain chosen | Org / platform |
| 8 Jurisdiction confirmed | every property's state is enabled for the org (§7) with its counsel-review flag set | Org + counsel |
| 9 Test send and test payment | one `Notification` delivered to the owner's own phone; one $1 invoice paid and projected | Org |
| 10 Go live | all above; the org's `status` becomes `ACTIVE` and crons include it | Platform |

A step that fails names why (Twilio's rejection text, Stripe's `requirements.currently_due`). The checklist is the owner's first screen until step 10, then a settings page.

## 6. Platform billing — open

The platform has no billing of its own today. The mechanism, when decided, is the foundation's `BillingAccount` pattern on the **platform's** Stripe account (the org is a Customer with one Subscription; `invoice.paid` / `payment_failed` on the existing platform webhook) plus a nightly per-org **meter** (active units, active leases) written to a `OrgUsage(orgId, day, units, leases, smsSegments)` row. Options for OQ-23, each with its consequence:

| Option | Shape | What it needs | What it costs the customer at 20 doors (PRD 08's draft numbers) |
|---|---|---|---|
| A Setup + per door | $500 once + $N/unit/month | the meter, Stripe metered price or monthly quantity update | $500 + 20 × $5 = $100/mo |
| B Setup + flat | $500 once + $99/month to 25 units, $4/unit above | a unit cap check, no meter below the cap | $500 + $99/mo |
| C Per door only | $N/unit/month, no setup | the meter; onboarding cost is unrecovered if they churn early | 20 × $6 = $120/mo |
| D Application fee only | 0.25–1% of collected rent via Connect, nothing else | nothing new beyond §2 | ≈ $60–240/mo on $24k rent, invisible to the owner |

A and D can combine. OQ-17 already asks whether B's numbers are acceptable; OQ-23 asks which model. Nothing in R-296 is built until it is answered.

## 7. Compliance — fair housing in manual approve/decline; jurisdiction per org

### 7.1 Decline reasons and audit (extends R-269, R-060, R-061)

What exists: a decision is recorded by a person (`recordScreeningDecision`, `lib/screening/staff-actions.ts:57`), a decline or conditional approval requires notes and writes the FCRA adverse-action notice in the same transaction (R-061), deciding out of listing order requires a `deviationReason`, and every decision is an `AuditLog` row. R-269 adds the "request more info" outcome and a reason list (contents gated on OQ-16, counsel).

What this PRD adds, per org:

- **The reason list is the org's** (`OrgDecisionReason(orgId, code, label, criteriaRef, active)`), and **every reason maps to a written criterion** in that org's `ScreeningCriteria` version. A reason with no criterion cannot be selected: "we just didn't like them" is not a reason the UI can record, which is the fair-housing safeguard — the stated reason is always a published, uniformly applied criterion.
- **`ScreeningCriteria` becomes per org** (`(orgId, version)`; today `@@unique([version])` is one sequence for the database, `:1427`, and `currentCriteriaVersion()` returns one global row, `lib/screening/criteria-queries.ts:22`). An org publishes its own criteria before its first application is accepted (checklist step 8 also gates on this).
- **Uniform application** stays R-060's order-of-application rule, scoped to the org's listing.
- **An adverse-action report per org** (quarter: decisions by outcome, by reason, by property; time from application to decision) — the record an org hands counsel or a HUD inquiry. Read-only, owner, exportable (§8).
- The notice templates (adverse action, approval, more-info) are the org's managed templates (R-270) with the org's brand; the FCRA-required contents stay in the typed template (D-44) and are not editable.

### 7.2 Jurisdiction per org, beyond seeded Texas

`JurisdictionRule` stays what D-4 made it: versioned, effective-dated, per state (and county), **not per org** — a statute is the same for every landlord in the state. Two things are per org:

- **Enabled states** (`OrgJurisdiction(orgId, state, counselReviewedAt?, counselReviewedBy?)`). A property in a state the org has not enabled cannot be created; enabling a state with no seeded rule raises a platform Task (seed it — R-278 is Oklahoma, the first), and D-4's counsel gate becomes a per-org flag the owner sets with a name and date, shown on every notice the rule produces until set.
- **Policy overrides, stricter only** (`OrgPolicy(orgId, state?, graceDays?, lateFeeMaxCents?, entryNoticeHours?, …)`): an org may give **more** grace, charge **less** than the cap, give **longer** entry notice. Core takes the stricter of statute and policy, never the looser, so a policy row cannot manufacture a violation. D-12 holds: core computes, Stripe executes.

## 8. Data ownership and exit

- **The org's data is the org's.** Every export that exists today (rent roll, settlement, tax export and packet, deposit and eviction packets, transcripts, statements — `app/api/reports/*`, `lib/*/packet.ts`, `lib/comms/transcript.ts`) is already per property or entity; R-299 adds **one org export**: a background job (`JobRun`, so it survives a 60-second function) that writes a zip of one CSV per org-owned table in schema order, every `Document` file, and the evidence packets, with a manifest naming the schema version and row counts. Owner-only, `report.financial` + fresh MFA, audited as `org.exported`, delivered as a time-limited download link. Expected size at 20 doors: tens of MB.
- **Offboarding** (R-300) is a state machine on `Organization.status`: `ACTIVE → FROZEN` (owner request with typed slug and fresh sign-in, or platform admin with reason) — memberships keep read access, every write is refused, crons skip the org, Stripe collection paused (subscriptions paused, not cancelled), Twilio number kept; `FROZEN → ACTIVE` restore within the window; `FROZEN → OFFBOARDED` after the window — export generated and delivered, Stripe disconnected (the account is theirs; nothing to delete), Twilio number released and subaccount closed, every non-append-only row purged, `Document` files deleted per `retention.ts`.
- **Retention** (OQ-26 for the numbers; defaults: 90-day freeze window, append-only tables kept 7 years): `LedgerEntry`, `AuditLog`, `Message`, `Notification` **cannot** be deleted and are not — they are the org's evidence trail and the platform's own record of what it did; they stay readable only by the platform admin under a support grant (§9) for the retention period, then are archived out of the live database by a job that is itself a Milestone 20 row. D-319.

## 9. Platform admin — super-admin view, support access with an audit trail

- **A platform admin is a separate principal kind** (`PlatformAdmin` table: email, sealed TOTP, active; `Principal.kind = 'platform'`), signed in on the bare base host at `/platform`, TOTP mandatory, no `StaffUser` row, **no org permissions at all**: `can()` returns `no_permission` for a platform principal on any org resource. D-5 is untouched because the platform admin is not a superuser — they can see the org list and health, and nothing inside an org (D-320).
- **The console** (`/platform/orgs`): every org with status, checklist progress, integration statuses, last cron outcome, dead-lettered events, open support grants, platform-billing state; create org, invite owner, freeze with reason, start offboarding, re-run a step. Reads come from org-less summary rows (`OrgHealth` materialised nightly) so the console never runs an org-scoped query without a grant.
- **Support access is a grant, not a session swap.** `SupportAccessGrant(orgId, platformAdminId, reason, requestedAt, approvedByStaffId?, expiresAt, revokedAt?)`. Two ways in: the org owner approves a request from their own settings page (the normal path), or **break-glass** — the admin opens it with a reason, the org's owners are notified immediately, and the grant lasts at most 60 minutes. While a grant is live the admin's requests to that org's host carry `actingUnderGrantId`; `currentActor` returns an actor with the **org owner's** scope (the least that can reproduce what the owner sees) and `kind: 'platform'`, every `AuditLog` row written in that time carries `actorType: PLATFORM`, `actorRef: <adminId>` and `supportGrantId`, and the org's own audit page lists the grant, its reason, and every action taken under it. Monetary actions (`checkMonetaryAuthority`) and `staff.manage` are refused under a grant regardless of scope: support reads and fixes, it does not approve money or change who has access.
- **The platform admin's own actions are audited** in an org-less `AuditLog` row (`orgId` null is allowed only for `actorType: PLATFORM` rows — a trigger says so).

## M. Migration inventory — what breaks under two orgs today, and which row fixes it

From the 2026-10-20 code audit. "Leak" = org A reads org B; "collision" = a unique refuses a legitimate second row; "wrong-org" = a side effect lands in the other org.

### M1. Schema

| Finding | Where | Class | Row |
|---|---|---|---|
| No `Organization`; `LegalEntity` is the root | `schema.prisma:457` | — | R-274 |
| 21 global models: `StaffUser`, `StaffCredential`, `Role`, `Tenant`, `Guarantor`, `TenantCredential`, `Vendor`, `MessageTemplate`(+Translation), `Audience`, `DocumentTemplate`, `InspectionTemplate`, `PreventiveMaintenanceTemplate`, `ScreeningCriteria`, `JurisdictionRule`, `SmsOptOut`, `TenantConsent`, `ProcessedStripeEvent`, `RateLimitCounter`, `AuthToken`, `UnroutedMessage`, `EventConsumption` | §1.2 | leak / collision | R-285 |
| Nullable `propertyId`/`legalEntityId` rows with no org: `ComplianceItem`, `Document`, `PropertyExpense`, `OutboxEvent`, `JobRun`, `Notification`, `AuditLog` | `:3708, 3757, 5496, 6181, 6604` | leak | R-285 |
| `StaffUser.email @unique` blocks one person in two orgs; invite check is a global oracle | `:2010`; `lib/staff/actions.ts:85` | collision / leak | R-285, R-288 |
| `SmsOptOut.phone @unique` — STOP to one org silences the other | `:6694` | wrong-org | R-285, R-292 |
| `ScreeningCriteria.version` global; `currentCriteriaVersion()` returns one row | `:1427`; `lib/screening/criteria-queries.ts:22` | collision | R-297 |
| `InspectionTemplate.defaultForType @unique` — one default per type for the database | `:6003` | collision | R-285 |
| Stripe-id uniques are global; ids are per account | `:4242, 4243, 4515, 4558, 4577` | collision | R-277 |
| `SmartLock(provider, externalId)`, `LeaseEnvelope.providerId` global | `:1679, 3599` | collision | R-285 |
| `AuditLog` has no org and no acted-as column | `:6602` | — | R-285, R-295 |

### M2. Auth and session

| Finding | Where | Class | Row |
|---|---|---|---|
| Null/null `StaffAssignment` is a cross-org superuser (`propertyScope` → `everything`) | `packages/core/rbac/can.ts:227-249` | leak (every scoped list) | R-285 |
| Session `Principal` carries no org | `apps/web/auth.ts:41-48, 115-148` | — | R-288 |
| Staff login and reset look up by global email | `lib/auth/actions.ts:110, 340` | — | R-288 |
| Tenant magic link `findFirst({ email })` on a non-unique column → **wrong-org login** | `lib/auth/actions.ts:464` | security | R-288 |
| Property switcher lists every property in the database for an owner | `lib/scope/current-scope.ts:21, 50-68` | leak | R-285 |
| Rate-limit keys are per IP with no org | `lib/auth/actions.ts:107,333,493,535`; `lib/prospects/actions.ts:94`; `lib/applications/actions.ts:279` | cross-org DoS | R-288 |
| Staff calendar token inherits `everything` | `app/api/calendar/[token]/route.ts:51` | leak | R-285 |

### M3. Queries that never go through `propertyWhere`

| Finding | Where | Class | Row |
|---|---|---|---|
| `listTemplates`, `listAudiences`, `audience.findFirst({ id })` | `lib/comms/templates.ts:37`; `lib/comms/announcements.ts:255`; `announcement-actions.ts:314` | leak | R-285 |
| `listVendors`, `getVendor`; vendor pickers on invoices, approvals, emergencies, PM; `approvals.ts` accepts any `vendorIds` | `lib/vendors/staff-queries.ts:12,17`; `money/vendor-invoices/page.tsx:31`; `workorders/approvals.ts:461`; `workorders/queries.ts:169`; `maintenance/emergency.ts:242`; `preventive-actions.ts:97` | leak / wrong-org dispatch | R-285 |
| `listStaff` (names, emails, assignments) | `lib/staff/queries.ts:33` | leak | R-285 |
| Document, inspection, PM, e-sign template lists | `lib/documents/template-queries.ts:14`; `lib/inspections/template-queries.ts:10`; `lib/maintenance/preventive-queries.ts:11`; `lib/leases/esign-staff-actions.ts:111` | leak | R-285 |
| Unrouted inbound queue is global, gated on `everything` | `lib/comms/queries.ts:113-124` | leak | R-292 |
| Ops panels gated on `everything`: dead letters, money ops, announcement history, job runs, outbox | `(admin)/notifications/page.tsx:76`; `(admin)/money/page.tsx:51`; `lib/comms/announcement-history.ts:42`; `lib/jobs/queries.ts:80-104`; `lib/jobs/outbox.ts:114,202` | leak | R-285, R-290 |
| `selectableTenants` with `everything` returns every tenant | `lib/leases/queries.ts:202` | leak | R-285 |
| Reconcile reads the whole event log and ledger | `lib/ledger/reconcile.ts:100-300` | leak / noise | R-277, R-290 |
| Opt-out store by phone | `lib/comms/opt-out-store.ts:31,53,77,119` | wrong-org | R-292 |

### M4. Money

| Finding | Where | Row |
|---|---|---|
| One secret key, cached provider, no `Stripe-Account`, no fee | `lib/billing/provider.ts:23,33,45`; `stripe-adapter.ts:53,108-190` | R-277 |
| One webhook secret; `event.account` never read | `app/api/webhooks/stripe/route.ts:27`; `lib/billing/webhook.ts:85,110,131,280` | R-277 |
| Customer lookup global | `lib/billing/webhook.ts:179`; `lib/applications/fee-webhook.ts:29` | R-277 |
| Publishable key baked at build | `portal/(signed-in)/pay/page.tsx:140`; `apply/[token]/page.tsx:138` | R-277 |
| No platform-fee ledger kind; no payout model | `LedgerEntry :4608`; `EntitySettlement :2332` | R-277 |

### M5. SMS and email

| Finding | Where | Row |
|---|---|---|
| One Twilio account/service, one Resend key/from; status URL from `AUTH_URL` | `lib/notifications/live-adapter.ts:48-60,135` | R-292, R-293 |
| Inbound and status verified against one token; `To` not used to pick an org | `app/api/sms/inbound/route.ts:44,57`; `sms/status/route.ts:41` | R-292 |
| Phone/email candidate lookup global → AMBIGUOUS across orgs | `lib/comms/threads.ts:112,153` | R-292 |
| One inbound email address and reply-key domain; one Resend webhook secret | `lib/comms/inbound-email-config.ts:22`; `lib/comms/messages.ts:38-60`; `api/webhooks/resend/route.ts:20`; `api/email/inbound/route.ts:103` | R-293 |
| `COMPANY_NAME` constant; `company.phone` null | `lib/comms/template-values.ts:56,139,145` | R-289 |
| Global sandbox/enabled switches | `lib/notifications/config.ts:57-58` | R-290 (per-org kill switch) |
| Links built from `AUTH_URL` | `lib/workorders/actions.ts:421`; `approvals.ts:476`; `maintenance/emergency.ts:312`; `lib/auth/delivery.ts:136` | R-289 |

### M6. Crons and sweeps

| Finding | Where | Row |
|---|---|---|
| Two crons, one `CRON_SECRET`, one 60-second invocation for every org; a slow org starves the rest | `apps/web/vercel.json`; `app/api/cron/route.ts`; `lib/cron/authorize.ts` | R-290 |
| `runDueJobs` iterates every active property; per-property isolation exists, per-org does not | `lib/jobs/runner.ts:126-146, ~390` | R-290 |
| Global sweeps with no org: outbox, notification claims, vendor no-response, entry and showing reminders, unanswered tenant messages, delists, COI, digest, escalations, reconcile | `lib/jobs/outbox.ts:114`; `lib/notifications/send.ts:646,666,767`; `lib/vendors/no-response.ts:53`; `lib/workorders/entry-reminders.ts:34`; `lib/showings/reminders.ts:42`; `lib/comms/unanswered-sweep.ts:58`; `lib/listings/delist-sweep.ts:42`; `lib/vendors/coi-job.ts:41`; `lib/notifications/digest-job.ts:33,95`; `lib/maintenance/escalation.ts` | R-290 |

### M7. Branding and config

| Finding | Where | Row |
|---|---|---|
| Fixed title, manifest, icon; ~30 pages say "Rental Operations" | `app/layout.tsx:14-16`; `app/manifest.webmanifest/route.ts`; `app/icon.svg` | R-289 |
| `NEXT_PUBLIC_OPERATIONS_PHONE` build-time | `app/global-error.tsx:25`; `vendor/[token]/error.tsx:27`; `components/vendors/vendor-help-line.tsx:19` | R-289 |
| One `AUTH_URL`, no host → org | `auth.ts`; `proxy.ts` | R-289 |
| TX-only seed; `/jurisdiction` edits affect every org | `packages/db/prisma/seed.mts:86-148`; `lib/jurisdiction/queries.ts:39` | R-298, R-278 |

### M8. Platform, admin, export, retention

| Finding | Where | Row |
|---|---|---|
| No super-admin, no impersonation, no acted-as audit | `create-owner.mts`; `lib/portal/guard.ts:25`; `AuditLog :6602` | R-294, R-295 |
| Exports are per property/entity; `everything` exports every org | `app/api/reports/*`; `lib/*/packet.ts` | R-285, R-299 |
| No offboarding or purge; retention is document-only | `packages/core/documents/retention.ts` | R-300 |
| Demo gate and seed host are global | `lib/demo-gate.ts`; `demo-database-guard.mts` | R-301 |

### M9. Tests and seed

| Finding | Where | Row |
|---|---|---|
| `create-owner` counts owners database-wide; no org argument; `db:create-staff` aliases it | `packages/db/prisma/create-owner.mts:86-91` | R-301 |
| Seed writes global roles, TX rule, criteria v1; demo seed hangs portfolio rows off no entity | `seed.mts:27-28,313-321`; `demo-seed.mts:63,225,366-612` | R-301 |
| 105 test files create a `LegalEntity` with no org; `uniqueStateCode()` exists to dodge the global jurisdiction unique; jobs tests assert exact run counts | `e2e/fixtures.ts`; `lib/jobs/jobs.test.ts` | R-301 (`uniqueOrg()` fixture) |
| Cross-property tests exist, cross-org do not | `lib/auth/scoping.test.ts`; `cross-property-ids.test.ts` | R-286 |

## 10. Backlog rows, decisions and open questions

Appended to `06-backlog.md` as **Milestone 19** and to `07-decisions.md` as **D-315–D-320** and **OQ-23–OQ-26** in the same commit as this document. Refined in place, not duplicated: R-272, R-273 (10DLC rate limit and status → depend on R-292), R-274 (org root → un-gated by D-315, spec §1), R-275 (`OrgIntegration` → spec §1.2, §3.1), R-276 (branding + custom domain → custom domain only; brand and subdomain move to R-289), R-277 (Connect → un-gated by D-316, spec §2), R-278 (Oklahoma → feeds §7.2).

**Order.** R-274 → R-285 → R-286 → R-288 → R-289 → R-290 → R-301 → R-275 → R-292, R-293 → R-277 → R-276 → R-291 → R-294 → R-295 → R-297 → R-298 → R-299 → R-300 → R-287 → R-296. The harness (R-286) is green before any integration row starts; org #1 is provisioned (R-291) only after R-277 and R-292, because the checklist's steps 5 and 6 do not exist before them.

**Not given rows, on purpose:** per-org custom roles (ROLE-07, unchanged); self-serve org signup (OQ-24; a row when there is a second prospect); archiving append-only rows out of the live database after retention (Milestone 20, needs the first offboarded org to size); the e-sign vendor (R-093 — `OrgIntegration(ESIGN)` is one row in R-275's table, the adapter is R-093's); QuickBooks per org (R-280 already stores tokens per org via R-275).

---

*This document contains no legal advice. 10DLC registration, TCPA consent language, fair-housing reason lists and state jurisdiction rules each require review by qualified counsel before the corresponding feature is enabled for a real customer. This is a learning project.*
