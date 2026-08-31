# Demo script

A driveable walkthrough of the product, one act per persona, against the local
`rental_demo` database. Written 2026-08-27 (R-122).

`DEMO-LOGINS.md` is the reference for how accounts and roles work and why.
**This file is the running order** — what to open, in what order, and what to
point at when you get there.

---

## 0. Bring it up (about two minutes)

```bash
npm run db:seed:demo-access      # staff passwords + fresh tenant/vendor links
npm run dev:demo                 # http://localhost:3100
```

If the database is empty or you want a clean slate first, run the setup
commands in `DEMO-LOGINS.md` §1, then the two above. They are all `:demo`-suffixed
npm scripts as of R-137 — the un-suffixed ones (`db:seed`, `db:seed:demo` before
the fix) pointed at the Neon dev branch, and both demo seeds now refuse any
database but a local `rental_demo` rather than trusting the env file.

`db:seed:demo-access` prints everything you need and is **safe to re-run** —
it resets the passwords and mints fresh links, which is what you want five
minutes before a demo. It **refuses to run against any database but the local
`rental_demo`**, checked on `DATABASE_URL` rather than `NODE_ENV`, because it
writes known passwords.

### The accounts it makes

Sign in at `http://localhost:3100/login`. **Password for all five:
`demo-rental-2026`.**

| Email | Role | Scope | What it is for |
|---|---|---|---|
| `owner@demo.test` | owner | all properties | The full product. Dana Reyes, the owner-operator. |
| `manager@demo.test` | manager | all properties | Runs the portfolio; **cannot** see Confidential or change access. |
| `tech@demo.test` | maintenance_tech | all properties | Jobs and inspections only. No money, no leases. |
| `partner@demo.test` | read_only | all properties | The bookkeeper or investor view. Sees, writes nothing. |
| `scoped@demo.test` | manager | **Riverside Court Duplex only** | ROLE-04. See the caveat in Act 5. |

**Tenants have no password and that is the product working correctly.** The
only tenant provider wired in `auth.ts` is `tenant-magic-link`; the
`TenantCredential.passwordHash` column is schema-only today. The script prints
a single-use magic link per tenant — paste one into the address bar. They are
short-lived, so re-run the script if a link has gone stale mid-demo.

**Vendors never get an account at all, ever (D-6).** The script prints one
signed, expiring, single-work-order link. That *is* the vendor experience.

Two-factor is off on all five accounts deliberately, so nothing asks for a
code from an authenticator nobody in the room is holding. To demo MFA on
purpose, `DEMO-LOGINS.md` → *Walking `/login/mfa` without a phone*.

---

## Act 1 — the owner opens the business (`owner@demo.test`)

**`/dashboard`.** Open on the numbers, because this is the screen that answers
"how is the portfolio doing" in one look.

- **Collected vs billed** for the current calendar month, and **aged
  delinquency** beside it. Point out that these reconcile against the rent
  roll one click away — that was a real defect found on a demo walk (R-117)
  and fixed, and it is the kind of thing only a walk catches.
- **Open tickets**, flagged against the emergency/urgent 48-hour mark.
- **Leases expiring ≤90 days**, renewal rate, pending approvals.

**`/properties`.** Six houses across **two LLCs** — Bluebonnet Holdings and
Sunshine Coast Holdings — in Texas. Open **Riverside Court Duplex**: a duplex
with two units, so it shows the multi-unit case without needing an apartment
building.

On a property page, the things worth naming:
- **The filing cabinet** — mortgages with ARM-adjustment and balloon alerts,
  insurance renewals, warranties, capital improvements. Every date here reads
  as `2 May 2026`, not `2026-05-02`, and a calendar day never passes through a
  timezone (R-121). **Everything a tenant or vendor receives** — a served
  notice, a generated lease, an amendment, a chargeback notice, the handoff
  packet, every emailed and texted notification — reads the same way since
  R-128. **A handful of internal screens still show the ISO form** (the rent
  roll's *Last contacted* column is the one you are most likely to open in
  front of somebody); that is R-129 and it is filed, not forgotten.
- **Maintenance spend** read straight off the work orders. There is no
  second store of the same money.
- **Claims** sit below the filing cabinet on purpose: a claim is opened
  against a policy that lives up there.

**`/money`.** Stripe is the system of record; `LedgerEntry` is an append-only
projection built from webhooks (D-11). Corrections are reversing entries —
there is no edit and no delete, enforced by a database trigger rather than by
application code.

**`/confidential`.** Sign out and back in as `manager@demo.test` to show this
link is simply **not in their nav** — filtered server-side, so the markup is
never sent. That is the RBAC point made in one move.

---

## Act 2 — a tenant reports a leak (a tenant magic link)

Paste **Maria Alvarez's** link. She lands on `/portal` — "Hello, Maria".

- **`/portal/maintenance`** — the seven-step wizard. Worth pointing at because
  it works **before hydration**: it is a real `<form action>`, not an
  `onClick`, so it functions on the first paint on a bad phone connection
  (R-112 fixed the opposite).
- **`/portal/pay`** — what is owed and why, in plain language, with the due
  date as a calendar day.
- **`/portal/notices`** — anything served on them, with proof of delivery.

Use **Derrick Holt's** link for the delinquency story instead: he owes exactly
this month's rent. Point out he reads as **1–5 days late, still within grace**
— he used to read *"Over 30 days"* because the system aged him from a move-in
proration he had paid on time in 2025. That defect also gated who could be
chased, so a tenant one day late was chaseable on day one whatever the statute
said (R-118, D-151).

---

## Act 3 — the vendor gets a text (the vendor link)

Paste the vendor link. It opens **one job** — "Quarterly HVAC filter
replacement" for Lone Star Heating & Air.

- **No account, no password, no sign-up.** The link is signed, expiring, and
  scoped to that one work order.
- Its lifetime tracks **the job's priority**, not a fixed number — a routine
  job booked a week out does not get an emergency's fuse.
- Reassigning the job or resending the link **kills the old one** in the same
  transaction, so "resend" is also "revoke the one I texted to the wrong
  number".
- The entry-notice line computes in the **property's** timezone, not the
  server's.

---

## Act 3.5 — the money you are only holding (`owner@demo.test`)

**This is the act to run if you only have time for one.** It is the part of
the job that generates the most disputes and the one a spreadsheet handles
worst, and until R-128 it could not be demoed at all — the seed set what the
lease *said* the deposit was and never recorded the money arriving, so every
screen read `$0.00` and the disposition page said *"This lease holds no
deposit."*

**`/money/rent-roll`.** Point at the **Deposit held** column: five tenancies,
four holding $1,600–$2,200, and **Grant Okafor at $0.00**. That zero is the
interesting one. Grant's tenancy was *inherited at acquisition* — the property
was bought with him already in it, and nobody ever established where his
deposit went. The system records that as `depositTransferStatus: UNKNOWN`
rather than guessing, and it is the only zero on the screen precisely because
the other four are real.

Say the rule out loud, because it is the whole design: **a deposit is a
liability, not income, and "held" means money that actually arrived.** The
figure is never derived from what the lease asked for. A tenant who paid
late, paid partially, or moved out has a lease number and a held number that
differ, and only one of them is defensible in a dispute.

**`/leases` → Wanda Combs → Deposit disposition.** Magnolia Drive House, main
house, moving out **3 Sept 2026**, **$1,950.00 held**.

- **Deductions are evidence, not line items.** Each one can be backed by the
  **work order** whose actual cost it is, and by a **move-out photo** from the
  inspection. A deduction with neither is a number you are asserting.
- **The depreciation check.** Fill in estimated age and useful life and it
  will argue with you about full replacement cost on a worn item — which is
  the argument you would otherwise have in front of a judge.
- **Texas gives 30 days** and that number is not in the code: it is
  `depositDispositionDays` on the jurisdiction rule, versioned and
  effective-dated (D-4). Change the state and the clock changes.
- **Finalize locks it.** The deduction list stops accepting edits, the letter
  is generated, and the flow moves to recording how it was served. Say that it
  cannot be undone, then don't press it — leave the demo with the story
  intact.

---

## Act 4 — the narrow roles (`tech@demo.test`, `partner@demo.test`)

Sign in as **`tech@demo.test`**. The nav is visibly shorter — Properties,
Maintenance, Work orders, Tasks, Messages, Notifications, Inspections,
Reports, Compliance, Preventive maintenance, Claims — and the point is what is
**missing: no Leases, no Money, no Notices.** The tech is the "phone in one
hand in a driveway at 3am" reader, and R-115 was a whole item spent on that
surface.

Sign in as **`partner@demo.test`** — the read-only bookkeeper or investor.
Sees, writes nothing. **Not quite a manager's reach**, and the difference is
worth pointing at rather than glossing: no Confidential, and also no Document
templates, no Evictions and no Gone dark. Those are places where merely being
in the room is the sensitive part, so read-only does not mean "the same screens
with the buttons greyed out".

---

## Act 5 — the property-scoped manager (`scoped@demo.test`)

Riley Chen manages **Riverside Court Duplex and nothing else**. This is
ROLE-04, and it is the most interesting thing the permission model does.

> **Riley used to be unmakeable in the app**, and as of R-138 is not: Act 6
> below grants exactly this scope from a screen. The seeded persona stays
> because a demo wants one ready.
>
> **This used to be the caveat in this file**, and it is worth saying out loud
> during a demo. Riley's left nav rendered **completely empty** until R-123:
> the filter asked `can(actor, permission)` with no resource, which only a
> portfolio-wide assignment can ever satisfy. Every page worked and scoped
> correctly the whole time — it was the way in that was missing, and no test
> saw it because every nav test signed in an owner. Found by driving this
> script.

Use the nav, and point at what is *not* in it — no Vendors, no Jurisdiction
rules, no Document templates. Those three are portfolio-wide by nature and
guard themselves with a resource-less check a scoped actor cannot pass, so
they stay hidden rather than dead-ending.

- **`/dashboard`** — *"In scope right now: 1 property."* Every tile is that
  one property's numbers.
- **`/properties`** — *"1 property in your scope."* Riverside Court Duplex
  only. The other five are not hidden in the markup; they were never queried.
- **`/leases`**, **`/money`**, **`/workorders`** — all scoped the same way.

Then say the part that matters: a record outside your scope answers **404, not
403** (ROLE-01), deliberately, so "forbidden" cannot be used to confirm that a
record exists.

---

## Act 6 — hiring, promoting and firing (`owner@demo.test`)

**`/staff`.** New in R-138, and the reason it is worth showing is that until
that item this screen did not exist: `grantAssignment()` had been written,
tested and called by nothing since R-004, so an owner could not add a
colleague, change what one could do, or cut off a leaver without a shell on
the server.

- **The directory lists active people only**, with a link to show
  deactivated ones. Deactivation preserves the row for ever (ROLE-06), so
  without that default the first screenful is eventually last year's leavers.
- **Add staff member** creates the account and mints a **single-use setup
  link**. No password is ever chosen for somebody else. The link is shown on
  screen as well as emailed — say why, because it is the honest version: auth
  links are printed to the terminal in development and **dropped entirely in
  production** today (R-139), so an invite that could only be emailed would be
  an invite that does not work where it matters.
- **Grant access** is where ROLE-04 stops being an abstraction: the scope
  select offers all properties, any legal entity, or **one property**. Grant
  Riley Chen the Riverside Court Duplex and Act 5 is something you built in
  front of the room rather than something the seed prepared.
- **Revoke** writes a timestamp, never a delete — the revoked row is the
  evidence the access existed. It moves to a *Revoked access* list below.
- **Deactivate** ends their sessions within a minute. Auth.js sessions are
  JWTs and cannot be deleted server-side, so it works by bumping a
  `sessionsValidFrom` watermark that `auth.ts` re-reads every ~30 seconds.

**Two things it refuses, and they are the interesting half.** Revoking the
**last owner assignment**, and **deactivating yourself**. There is no
superuser (D-5), so either one would leave a deployment whose only way back in
is a script on the server — they are refusals at a trust boundary, not
confirm dialogs.

**You need a second factor to press any of it.** `staff.manage` is on
`PRIVILEGED_PERMISSIONS`, and `db:seed:demo-access` clears MFA on every run —
so enrol first (`DEMO-LOGINS.md` → *Walking `/login/mfa` without a phone*) or
this act is a locked door. A manager signs in and sees the directory with no
controls at all, which is its own point worth making.

---

## If something looks wrong

- **Landed on `:3001`?** Something else holds `:3100`. `lsof -ti :3100`.
- **A tenant link says expired?** Re-run `npm run db:seed:demo-access`.
- **A sign-in hangs after "Sign in"?** Staff login is rate-limited to ten
  attempts per IP per five minutes (R-003). Wait it out.
- **The demo database drifts** — `--reset` retires rather than deletes,
  because append-only tables reference those rows, so retired properties and
  entities accumulate. Harmless; they are filtered out of every screen.
