# Demo logins and roles

How to get into every surface of this product with a seeded demo database.
Written 2026-08-25 after R-105's demo walk; corrected 2026-08-29 (R-137).

**Start at [DEMO-SCRIPT.md](DEMO-SCRIPT.md) §0 if you just want to sign in.**
`npm run db:seed:demo-access` makes five staff accounts with one documented
password and prints a magic link per tenant and vendor. This file is the
reference for *how* accounts and roles work, and for the paths that script does
not cover.

**The product has no fixed passwords; the demo seed has exactly one, and it
refuses to run anywhere it could matter.** That distinction is the whole of it:
`db:create-owner` mints a single-use setup link and never prints a credential,
because a password in a repo is a password in every clone of it — while
`db:seed:demo-access` (R-122) writes the known `demo-rental-2026`, on the global
convention's own terms, *"known-value demo credentials are fine when the seed
that uses them refuses to run in production, and the file should say so."*
It says so, and it refuses: `refuseUnlessDemoDatabase` rejects any
`DATABASE_URL` that is not a local `rental_demo`.

**This file used to open by claiming there were no fixed passwords anywhere in
this repo.** That was written two days before R-122 made it false, and it stayed
on the page until R-137. Tenants and vendors still have no password at all, and
that part was never in doubt.

---

## 1. Bring up the demo database

Run once, in order. Every script below carries `-e .env.demo -e .env.local`, so
it hits the LOCAL `rental_demo` database rather than the Neon dev branch.

```bash
createdb rental_demo                     # once, if it does not exist yet
npm run db:migrate:demo                  # every migration
npm run db:seed:base:demo                # roles + the Texas jurisdiction rule
npm run db:create-owner:demo -- --email owner@demo.test --name "Dana Reyes"
npm run db:seed:lease-templates:demo -- --staff owner@demo.test
npm run db:seed:demo                     # the demo portfolio, tenants and money
npm run db:seed:demo-access              # the five staff logins and the links
```

**These used to be raw `npx dotenv -e .env.demo …` lines, and that was load
bearing** — the obvious script names (`db:seed`, `db:create-owner`,
`db:seed:lease-templates`, `db:seed:demo`) all carried only `-e .env.local`,
which is the Neon dev branch, so writing them out longhand was the only way to
be right. R-137 added the `:demo` variants and, more to the point, a **refusal
inside both demo seeds**: pointed anywhere but a local `rental_demo` they now
exit 1 naming the database they were given, rather than seeding it.

**The order is forced, not a preference.** `db:seed:lease-templates:demo` needs
a staff user to attribute the wording to; `db:seed:demo` throws without a lease
template, because an e-signature envelope with no template behind it is an
envelope wrapping nothing; and `db:seed:demo-access` throws without the
Riverside Court Duplex that `db:seed:demo` creates, since one of its five
personas is scoped to it. There is no one-shot chain script because
`db:create-owner` refuses an address that already exists, so a chain would have
to swallow a real error to stay re-runnable.

`owner@demo.test` is used above so that the account this creates is the same one
`db:seed:demo-access` later resets to the documented password — any address
works, but a second one is just an extra account to explain.

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

**For a demo, you do not need any of this** — `npm run db:seed:demo-access`
makes all five accounts, with a password, in one command. Use the script below
when you want an account this repo has no seeded persona for, or on a database
`db:seed:demo-access` refuses to touch.

```bash
# The owner (first, and only once — the script refuses a second without --force)
npm run db:create-owner:demo -- --email owner@demo.test --name "Dana Reyes"

# One of each other role
npm run db:create-owner:demo -- --email manager@demo.test --name "Pat Morales" --role manager
npm run db:create-owner:demo -- --email tech@demo.test --name "Sam Okonkwo" --role maintenance_tech
npm run db:create-owner:demo -- --email partner@demo.test --name "Jo Bookkeeper" --role read_only
```

**`--` before the flags is not optional.** Without it npm eats them and the
script sees no arguments at all.

Against a non-demo database, `npm run db:create-staff -- --role manager …` is
the same script with the same flags.

Each run prints a **single-use setup link** that expires in about an hour:

```
Single-use setup link - open it to set a password:
  http://localhost:3100/reset-password?token=…
```

Open it, set a password, and that account can sign in at `/login`. Re-run the
script if the link lapses. Two-factor is **optional** — `/login` only demands a
code from an account that has enrolled — so a demo account can skip it.

### Walking `/login/mfa` without a phone

**R-128 walked it end to end, then put MFA back off.** R-117 had cleared it to
get through the screens, so `/login/mfa` was one of two routes no walk had ever
seen; it has now been enrolled, challenged and signed through to `/dashboard`.
**Every demo account is back to two-factor OFF**, which is the state a demo
needs — `db:seed:demo-access` clears it on every run, and R-128 finished by
running it. Nothing will ask you for a code.

Two things that walk established, worth having written down before you enrol
on purpose:

- **The secret is shown once, on the enrolment screen, and nowhere else.**
  There is no recovery path through this repo if you close that page without
  saving it — clear MFA and start again.
- **A scripted walk needs the TOTP step.** Anything driving the browser has to
  fill `/login/mfa` before it reaches `/dashboard`, and a script that waits for
  a URL outside `/login` hangs for its full timeout on `/login/mfa`, which
  starts with `/login`.

You do not need an authenticator app to cover this route, and **no TOTP secret
is seeded or written down here** — that would be the fixed credential the top
of this file says does not exist.

1. Sign in, go to `/account`, and start enrolment. The screen prints the
   base32 secret as text beside the QR code, for exactly this reason.
2. Generate the current code from that secret:

   ```bash
   # One line: the assignment must be a prefix, or the subprocess never sees it.
   SECRET=<the base32 the screen printed> npx tsx -e "import {Secret,TOTP} from 'otpauth';console.log(new TOTP({secret:Secret.fromBase32(process.env.SECRET)}).generate())"
   ```

   Same call the e2e suite makes (`e2e/auth.spec.ts`), and `otpauth` is already
   a dependency — there is nothing to install.
3. Paste it to confirm enrolment, **write down the recovery codes it shows**,
   and re-run the command whenever `/login` asks. Codes last 30 seconds.

To clear MFA again for a later walk:

```bash
npm run db:seed:demo-access
```

It already carries `-e .env.demo -e .env.local`, and it resets the password and
clears `mfaSecret` / `mfaEnrolledAt` / `mfaRecoveryCodes` for every demo
persona — the comment in `seed-demo-access.mts` says why: *"a demo account that
demands a code from an authenticator nobody in the room holds is a locked
door."*

**This file used to say `create-owner.mts --force`, and that does not work**
(found by R-128's walk). `--force` only bypasses the *second owner* guard; the
script refuses an address that already exists no matter what, with *"A staff
user already exists for … This script creates a NEW one"*. There is also **no
in-app way to turn two-factor off** — `/account` offers enrolment and
re-enrolment, never removal — so the seed script is the only route.

### The gap this used to paper over — closed by R-138

**There is now in-app staff management, at `/staff`.** An owner adds a
colleague, grants and revokes roles at any scope, edits per-person approval
ceilings and deactivates a leaver from a screen. `grantAssignment()` and
`revokeAssignment()` finally have the caller their own comment has promised
since R-004.

What that changes for a demo:

- **ROLE-04's property-scoped manager can be made in the app.** The scope
  select offers all properties, any legal entity, or any single property, so
  Riley Chen's grant no longer needs a hand-written `StaffAssignment` row.
- **`db:create-owner` is a bootstrap, not the only door.** Use it for the
  FIRST owner on a fresh database; everything after that belongs on `/staff`,
  where the grant is audited against the person who made it rather than
  against a script.
- **The screen is owner-only and MFA-gated.** `staff.manage` is on
  `PRIVILEGED_PERMISSIONS`, so an owner who has not enrolled a second factor
  is sent to `/account` to enrol before any control renders. A manager holds
  `staff.read` and sees the directory with no controls on it. That is the
  product working — and it means **demoing `/staff` needs the TOTP step**
  above, because `db:seed:demo-access` clears MFA on every run.
- **The invite screen shows the setup link as well as emailing it**, which is
  what makes it demoable at all: see *Where the link actually appears* below —
  auth links are printed to the terminal in development and, as of today,
  dropped entirely in production (R-139).

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
