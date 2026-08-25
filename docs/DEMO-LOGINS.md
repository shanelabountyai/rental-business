# Demo logins and roles

How to get into every surface of this product with a seeded demo database.
Written 2026-08-25, after R-105's demo walk.

**There are no fixed passwords anywhere in this repo, deliberately.** Staff set
their own through a single-use link the bootstrap script prints; tenants and
vendors never have one at all. Nothing below is a credential — every line is
either a command you run or an address you type into a form.

---

## 1. Bring up the demo database

Run once, in order. All five use `.env.demo` first so they hit the LOCAL
`rental_demo` database rather than the Neon dev branch (see CLAUDE.md).

```bash
npx dotenv -e .env.demo -e .env.local -- npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/seed.mts                 # roles + the Texas jurisdiction rule
npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/create-owner.mts --email you@example.test --name "Your Name"
npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/seed-lease-templates.mts
npx dotenv -e .env.demo -e .env.local -- npx tsx packages/db/prisma/demo-seed.mts
```

Then serve it:

```bash
npm run dev:demo          # http://localhost:3100
```

`:3100` is this repo's port. If you land on `:3001` something else already holds
`:3100` — check `lsof -ti :3100` before anything else.

---

## 2. Staff — five roles, and how to make one of each

### The roles

Defined once in `packages/core/rbac/permissions.ts` and seeded as rows by
`db:seed`. Code refers to them by `key`, never by name (D-5).

| key | Name | What it can do | Approve work order | Waive fees |
|---|---|---|---|---|
| `owner` | Owner | Everything, across every property. **There is no superuser flag** — unrestricted access *is* this role with a null scope (D-5). | unlimited | unlimited |
| `manager` | Manager | Runs the portfolio day to day: leases, screening decisions, payments, tickets, work orders, vendors, inspections, notices. **Cannot change who has access, and cannot adjust the ledger.** | $500.00 | $100.00 |
| `maintenance_tech` | Maintenance Tech | Tickets, work orders and inspections. No money, no leases, no tenant records beyond what a job needs. | $0 | $0 |
| `read_only` | Read-only / Partner | Sees, writes nothing. The role to hand an investor or a bookkeeper. | $0 | $0 |
| `tenant` / `guarantor` | — | **Not staff roles.** Held by `Tenant` actors on the portal, never by a `StaffUser`. The script below refuses them. | — | — |

Ceilings are per-role defaults; `StaffUser.approveWorkOrderCents` /
`waiveFeeCents` override them per person (ROLE-02), and **zero is a real value**
meaning "may approve nothing" — the fallback is on null, not on falsiness.

### Making the accounts

```bash
# The owner (first, and only once — the script refuses a second without --force)
npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/create-owner.mts \
  --email owner@example.test --name "Dana Reyes"

# One of each other role
npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/create-owner.mts \
  --email manager@example.test --name "Pat Morales" --role manager

npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/create-owner.mts \
  --email tech@example.test --name "Sam Okonkwo" --role maintenance_tech

npx dotenv -e .env.demo -e .env.local -- node packages/db/prisma/create-owner.mts \
  --email partner@example.test --name "Jo Whitlock" --role read_only
```

Against a non-demo database, `npm run db:create-staff -- --role manager …` is
the same script with the same flags.

Each run prints a **single-use setup link** that expires in about an hour:

```
Single-use setup link - open it to set a password:
  http://localhost:3100/reset-password?token=…
```

Open it, set a password, and that account can sign in at `/login`. Re-run the
script if the link lapses. Two-factor is **optional** — `/login` only demands a
code from an account that has enrolled — so a demo account can skip it, and an
account that enrols needs an authenticator app.

### The gap this papers over

**There is no in-app staff management.** `grantAssignment()` in
`apps/web/lib/staff/assignments.ts` has no caller anywhere in the app, so an
owner cannot add a colleague from a screen — which is why `--role` had to be
added to a bootstrap script to make roles demonstrable at all. Two consequences
for a demo:

- Every account this script makes is scoped to **all properties**. ROLE-04's
  property-scoped manager — arguably the most interesting thing RBAC does here —
  cannot be created without writing a `StaffAssignment` row by hand.
- Revoking access is the same story: `revokeAssignment()` also has no caller.

---

## 3. Tenants — the portal, by magic link

Tenants have **no password by design**: "friction is what keeps tenants off a
portal". Sign in at `/portal/login` with the email address on the lease.

| Tenant | Email | Property / unit | What their screens show |
|---|---|---|---|
| Maria Alvarez | `maria.alvarez@example.test` | Bluebonnet Lane House · Main house | Current and paid — the happy path |
| Derrick Holt | `derrick.holt@example.test` | Riverside Court Duplex · Unit A | **Behind.** Overdue rent, late fee, a notice to vacate and the eviction case built on it |
| Priya Nair | `priya.nair@example.test` | Riverside Court Duplex · Unit B | In notice — the tenancy is ending |
| Wanda Combs | `wanda.combs@example.test` | Magnolia Drive House · Main house | Moving out — move-out inspection and deposit disposition |
| Grant Okafor | `grant.okafor@example.test` | Sunset Boulevard Townhouse · Main unit | Inherited at acquisition, now month-to-month |
| Imani Oyelaran | `imani.oyelaran@example.test` | Bluebonnet Lane (the listed unit) | Mid-signing — lease `PENDING_SIGNATURE`, guarantor still out |

**Where the link actually appears.** With no `RESEND_API_KEY` / `RESEND_FROM`
set, `LiveChannelAdapter` falls back to logging, so the email is printed to the
terminal running `npm run dev:demo`:

```
[notifications] EMAIL -> maria.alvarez@example.test | Sign in to your home
… http://localhost:3100/portal/verify?token=…
```

Paste that URL into the browser. `@example.test` is not a deliverable domain, so
this is the only way in even if you *do* set real keys — which is the point.

The form always answers the same way whether or not the address exists. That is
not a bug: it refuses to confirm who is a tenant.

---

## 4. Vendors — a magic link per job, no account

Vendors never sign in. A work order assigned to a vendor mints a tokenised link
to `/vendor/[token]`; a bid request mints one to `/vendor/bid/[token]`. Get one
by assigning a work order to one of the three seeded vendors as staff, then
reading the link out of the same server log as above.

| Vendor | Email |
|---|---|
| Hill Country Plumbing | `dispatch@hillcountryplumbing.example` |
| Lone Star Heating & Air | `service@lonestarheatingair.example` |
| Ridgeway Handyman | `office@ridgewayhandyman.example` |

---

## 5. The stranger-facing routes, and why they are empty

Six routes take a token and nothing else. **The demo seed mints none of these
links** — R-105 flagged it and it is still true, so these screens have never
been walked outside the test suite.

| Route | Who holds the link | How to get one in the demo |
|---|---|---|
| `/apply/[token]` | An applicant | Send an application to a prospect from `/prospects` |
| `/prescreen/[token]` | An enquirer | Send a pre-screen from a prospect |
| `/sign/[token]` | A lease signer | Send Imani Oyelaran's envelope from `/leases` |
| `/showings/[token]` | A prospect booking a viewing | Publish a showing slot from a listing |
| `/showings/access/[token]` | A prospect at the door | Issue an access code for a booked showing |
| `/pay/[token]` | A tenant paying from a reminder | Send a rent reminder to Derrick Holt |
| `/vendor/bid/[token]` | A vendor quoting | Request bids on a work order |

Every one of them lands in the server log the same way. Golden Path 4 covers the
stranger's path in the e2e suite, so this is a demo gap rather than an untested
one.

---

## 6. What is deliberately empty

`/claims`, `/abandonment` and `/confidential` seed nothing, on purpose — a
confidential case in a demo database is a screen somebody screenshots.
