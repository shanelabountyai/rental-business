# Demo script

A driveable walkthrough of the product, one act per persona, against the local
`rental_demo` database. Written 2026-08-27 (R-122) as `DEMO-SCRIPT.md`;
renamed and refreshed at project closure on 2026-11-10, when Acts 7 and 8
(messaging, and the multi-organisation platform console) were added.

`DEMO-LOGINS.md` is the reference for how accounts and roles work and why.
**This file is the running order** — what to open, in what order, and what to
point at when you get there.

---

## 0. Bring it up

**Already set up** (about thirty seconds):

```bash
npm run db:migrate:demo          # not optional: a stale rental_demo has bitten twice
npm run db:seed:demo-access      # staff passwords + fresh tenant/vendor links
npm run dev:demo                 # http://localhost:3100
```

**From nothing** (about three minutes; run once, in this order):

```bash
createdb rental_demo
npm run db:migrate:demo
npm run db:seed:base:demo
npm run db:create-owner:demo -- --email owner@demo.test --name "Dana Reyes"
npm run db:seed:lease-templates:demo -- --staff owner@demo.test
npm run db:seed:demo
npm run db:seed:demo-access
npm run db:create-platform-admin:demo -- --email platform@demo.test --name "Sam Ortiz" --target localhost/rental_demo
npm run dev:demo
```

The order is forced; `DEMO-LOGINS.md` §1 says why. Every script is
`:demo`-suffixed (R-137): the un-suffixed ones carry only `-e .env.local`,
which is the Neon dev branch, and the demo seeds and the platform-admin script
each refuse any database but the one they were pointed at deliberately.

**`.env.demo` must carry `PLATFORM_HOST=platform.localhost` and
`ORG_BASE_DOMAIN=orgs.localhost`** for Act 8 — the same values Playwright
sets. Without them the platform-admin script prints *"PLATFORM_HOST is unset,
so this deployment has no console"* and Act 8 has nowhere to go. Added
2026-11-10; a `.env.demo` from before that date lacks them.

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
a single-use magic link per tenant — paste one into the address bar, then press *Continue* (the link no longer signs in on open). They are
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

**`/properties`.** Six properties (houses, a condo and a townhouse) held by
**two LLCs**: Bluebonnet Holdings has four in **Texas**, and Sunshine Coast
Holdings has two in **Florida**. Two states is the point of D-4: every
deadline and cap is read from that state's jurisdiction rule. Open
**Riverside Court Duplex**. It has two units, so it shows the multi-unit case
without needing an apartment building.

On a property page, the things worth naming:
- **Maintenance spend** read straight off the work orders. There is no
  second store of the same money.
- **The filing cabinet**: mortgages with ARM-adjustment and balloon alerts,
  insurance renewals, warranties and capital improvements. The seed puts one
  ARM mortgage on **Bluebonnet Lane House** (Gulf Coast Federal Credit Union,
  adjusting about five weeks out), so *Renewals & alerts* reads 1 and drills
  into it (R-252). No warranty or capital improvement is seeded; add one live
  if you want to show them. Every date in the product reads as
  `2 May 2026`, not `2026-05-02`, internal screens included since R-129, and
  a calendar day never passes through a timezone (R-121).
- **Claims** sit below the filing cabinet on purpose: a claim is opened
  against a policy that lives up there. Riverside has no policy, so its page
  says a claim cannot be opened. The one seeded claim is on **Bluebonnet Lane
  House**.

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

- **`/portal/maintenance`** → **Report a problem** (`/portal/maintenance/new`)
  — the seven-step wizard. Worth pointing at because it works **before
  hydration**: each step is a real `<form method="get">`, not an `onClick`, so
  it functions on the first paint on a bad phone connection (R-112 fixed the
  opposite). The landing page itself is the list of what she has sent.
- **`/portal/pay`** — what is owed and why, in plain language, with the due
  date as a calendar day.
- **`/portal/notices`** — anything served on them, with proof of delivery.

Use **Derrick Holt's** link for the delinquency story instead. He owes
**$3,300.00 — two months**: his July payment was **returned by the bank** a
few days after it landed, and this month's invoice was declined. The rent
roll reads him as **Over 30 days, past grace**, aged from the returned July
rent, which is the oldest money he actually owes. Aging is from the oldest
*unpaid* charge; it used to be the move-in proration he paid on time in 2025,
and that defect also gated who could be chased, so a tenant one day late was
chaseable on day one whatever the statute said (R-118, D-151). His portal
offers **Turn on automatic payments** because he has no card on file, and the
rent roll agrees: until R-250 it labelled him *autopay* from the collection
method alone.

---

## Act 3 — the vendor gets a text (the vendor link)

Paste the vendor link. It opens **one job**: "Quarterly HVAC filter
replacement" at Coral Way Condo, assigned to Lone Star Heating & Air. The page
names the job and the address, not the vendor, because whoever holds the link
already knows who they are.

- **No account, no password, no sign-up.** The link is signed, expiring, and
  scoped to that one work order.
- Its lifetime tracks **the job's priority**, not a fixed number — a routine
  job booked a week out does not get an emergency's fuse.
- Reassigning the job or resending the link **kills the old one** in the same
  transaction, so "resend" is also "revoke the one I texted to the wrong
  number".
- Any proposed or booked window reads in the **property's** timezone, not the
  server's. The seeded job is `ASSIGNED` and not yet booked, so no window
  shows until you press **Propose a different time**.

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
house, **$1,950.00 held**, notice given, and the lease ends **five days after
the day you seeded** — every seeded date is relative to the seed run, so
re-seed rather than trust a date printed here. There is no recorded move-out
date yet: R-248 stopped the seed writing a future one on an active lease.

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
  screen as well as emailed, a choice made while auth links were **dropped
  entirely in production**. R-139 fixed that, so the email now arrives too,
  and the on-screen copy is a fallback.
- **Grant access** is where ROLE-04 stops being an abstraction: the scope
  select offers all properties, any legal entity, or **one property**. The
  seed already scopes Riley Chen to the Riverside Court Duplex, so to build
  Act 5 in front of the room, grant the same scope to a person you have just
  added.
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
this act is a locked door. **The door has no sign on it**: without MFA the
owner sees the same bare directory a manager does, with no *Add staff member*
button and no hint about why (walked 2026-09-23). A manager signing in and
seeing no controls is its own point worth making, but only after you have
enrolled the owner.

A local `rental_demo` created before 2026-08-27 lists **two Dana Reyes**
rows. `owner@example.test` is a leftover from before the `@demo.test`
convention. A database set up fresh from `DEMO-LOGINS.md` has only one.

---

## Act 7 — one message to the right tenants (`owner@demo.test`)

**`/messages/announcements`.** The send-to list is the point: not "all
tenants" or nothing, but **segments the owner already thinks in** — balance
due (2 tenants), open maintenance request (5), move-out within 30 days (2),
month-to-month (1), plus any entity, property, unit or tag. Each segment
shows its head-count *before* you write a word.

- **Preview before send** (R-260): the composer renders the message as one
  real recipient will get it, merge fields filled — portal link, owner name,
  owner phone (R-265).
- **Review the recipient list**, untick anyone, save it as an audience
  (R-259). Schedule it for later (R-261). After it goes, **History** shows
  delivery per recipient, and *resend to failed only* re-sends to the ones
  that bounced and nobody else (R-262).
- **A tenant's reply becomes a Task** (R-263, D-329), on the one staff queue
  (D-9), not a second inbox.

**`/messages/settings`.** Per-property quiet hours, the SMS footer, and who
gets tenant replies (R-266). The **texting number** panel reads *"No texting
number is set up, so texts to tenants are not sent"* — correct for the demo,
which blanks the Twilio keys on purpose so nothing reaches a real phone. On a
live org it shows whether the number is toll-free or 10DLC and where its
carrier registration stands (R-273). Below it, the owner can change the
**greeting and closing** of four automated emails, and only those — the
amounts, dates and legal sentences stay fixed (R-268, D-405).

Say the rule: **a maintenance tech cannot send free text to a tenant**, only a
template (R-267, D-404). That rule is about liability: a tech
promising a date in their own words is a promise the business has to keep.

---

## Act 8 — many landlords, one platform (`platform@demo.test`)

The product is built **multi-organisation**: each landlord business is an
org, with its own host, brand, Stripe account, texting number and email
domain, and a platform console above them all (PRD 10, PRD 11). Org #0 is
the demo portfolio; no second org is live.

**Get in.** Open the setup link the platform-admin script printed (it lasts
30 minutes and works once) at `http://platform.localhost:3100/...`, set a
password — use `demo-rental-2026` to keep the convention — then sign in at
`http://platform.localhost:3100/platform/login`. **The console has no way to
skip two-factor**, so it goes straight to enrolment: generate the code with
the `otpauth` one-liner in `DEMO-LOGINS.md` → *Walking `/login/mfa` without a
phone*. Lost the link? `npm run db:create-platform-admin:demo -- --reset-mfa
--email platform@demo.test --target localhost/rental_demo` clears the second
factor; a lost *password* means rebuilding `rental_demo`, because the script
refuses a second platform owner.

- **`/platform/orgs/default`** — and the first thing to point at is what is
  **not** there: *"Viewing inside this organisation needs a support grant. Its
  properties, tenants, leases, money, messages, documents, staff and audit log
  are not shown here."* The platform operator cannot read a landlord's tenants
  by default. Access is a time-boxed, **read-only support grant** (R-295a/b,
  D-358). Concede the edge before you are asked: there is a break-glass path
  for incidents, also read-only, 60 minutes and loud, and no organisation can
  opt out of it (D-361).
- **Freeze**, **notifications off**, **platform fee** — each needs a fresh
  two-factor code and a written reason, and each writes to the org's own
  audit log and emails its owners. Freezing pauses rent collection; it does
  not cancel subscriptions (R-300a).
- **`/platform/orgs/new`** creates an org and invites its owner (R-304a). The
  new org lives at `http://<slug>.orgs.localhost:3100`. **Data isolation is
  proved, not assumed**: every query is scoped to the actor's org, and a
  cross-org harness (R-286) proves every server action refuses another org's
  row. Row-level security is the second wall — every org-owned table has a
  policy, and it is enforced in the test suite but **off in production**
  (R-287b, D-392). Say so here, not only in the concessions.
- **`/platform/jurisdiction`** — the state rules are **published by the
  platform**, and an org can only make them stricter, never looser (R-305,
  R-298b).

---

## If something looks wrong

| Symptom | Cause | Fix |
|---|---|---|
| Landed on `:3001` | Something else holds `:3100` | `lsof -ti :3100` |
| A tenant link says expired | Links are single-use and short-lived | `npm run db:seed:demo-access` |
| A sign-in hangs after "Sign in" | Staff login allows ten attempts per IP per five minutes (R-003) | Wait it out |
| `db:seed:demo` prints ~15 `processing fee read failed … No such invoice: 'in_demo…'` | The seed replays made-up invoice ids, and R-282b's fee read asks the real Stripe test account about them | Harmless: the seed exits 0. Demo payments simply carry no processing fee |
| `/settings/setup`, `/staff` or `/money/deposits` lands on `/account?mfa=required` | They need a privileged permission, and the demo accounts start with two-factor off | Enrol first (`DEMO-LOGINS.md` → *Walking `/login/mfa` without a phone*) |
| `platform.localhost` refuses, or the console says it does not exist | `PLATFORM_HOST` missing from `.env.demo` | See §0, then restart `dev:demo` |
| `/money/quickbooks/simulated` is a 404 | It is the simulated Intuit consent screen; it needs the `state` the Connect button mints | Start from **Connect QuickBooks** on `/money/quickbooks` |
| Retired properties pile up in the database | `--reset` retires rather than deletes, because append-only tables reference those rows | Harmless; every screen filters them out |

---

## What to concede before you are asked

Say these first. Volunteering a caveat reads as confidence; having it pulled
out of you does not.

- **Nothing here touches real money.** Stripe runs in test mode only (D-26);
  there is no live key anywhere by design. The ledger is a projection of Stripe
  test events.
- **A move-out credit lives on our ledger and Stripe is never told** (D-302,
  D-308). When a tenant leaves mid-month, the days they paid for and did not
  live are credited on the ledger only, and the deposit letter returns or
  nets that credit. Stripe still holds the full final invoice. For a tenant
  in arrears that invoice stays open at Stripe for the credited amount and
  autopay may retry it. Fine in test mode; **a real deployment needs a Stripe
  credit note built before go-live**, and that is not built.
- **Screening and e-signature are simulated adapters** (PRD 00 §14), built not
  to agree with us by construction (D-27). No real vendor API was ever called.
- **The legal wording is draft-only and is not legal advice.** The seeded Texas
  jurisdiction rules have **not been reviewed by an attorney** — that gate is
  open, and `docs/LEGAL-REVIEW-CHECKLIST.md` is the hand-off for it.
- **One known legal gap:** an entry notice that goes unserved and is later
  served by hand does not re-judge the entry window (R-228). It needs counsel
  on damages for entries already made, so it is deliberately unbuilt.
- **Demo data is synthetic and local.** `rental_demo` is seeded, and the demo
  password `demo-rental-2026` exists only because both demo seeds refuse any
  database but a local `rental_demo`.
- **The production deployment is behind one shared password** — the app's
  own demo gate, not Vercel's login (checked 2026-09-23) — and it holds no
  real tenants. The Neon dev branch reports every migration as unapplied;
  deployed databases owe the `db:migrate` and `db:seed` runs `NEXT.md`
  lists.
- **Multi-org is built and only one org is live.** The provisioning paths for
  a second landlord (Stripe Connect onboarding, a Twilio number, a Resend
  domain, a custom domain on Vercel) run against **simulators**; the real
  StripeConnector, TwilioProvisioner, ResendProvisioner and VercelDomains are
  not built. The neutral domain and wildcard DNS (D-324) do not exist yet.
- **Row-level security is enforced in tests and off in production** (R-287b,
  D-392). Production isolation rests on the application's own org scoping,
  which the cross-org harness proves; RLS is the second wall, and it is not
  yet on in production.
- **QuickBooks is a simulated company file** (R-279). The real Intuit driver
  is not built, and with the simulator the QuickBooks side lives in process
  memory, so a deployed reconciliation page can show variance that is not
  real. Deposit disposition never reaches the ledger, and dispute fees are
  not read (R-282a/b).
- **Two counsel gates are open**: which states the second portfolio needs
  (OQ-14, which blocks the Oklahoma rules) and the screening decline-reason
  list (OQ-16), which ships as placeholders and is kept out of the
  adverse-action notice until reviewed.
- **Texting is real and switched off here.** Org #0 has a verified toll-free
  number and has delivered a live text, but `.env.demo` and `.env.test` blank
  the Twilio keys on purpose. The demo sends nothing to a phone.
- **Not every screen has an act.** Deposits, month-to-month notices, the
  guarantor account, abandonment, claims, renewals, screening criteria and
  the tax packet are real and walked but not scripted here. `/money/deposits`
  needs two-factor (see the troubleshooting table), as `/staff` does.

**Verified 2026-11-10 at closure**, against a `rental_demo` dropped and rebuilt
from nothing with every command in §0 (all exit 0). Signed in as
`owner@demo.test`, **86 admin routes returned 200** — every static page plus
the first record under each list — with no `undefined`, `NaN` or
`Invalid Date` on any of them. The one 404 is `/money/quickbooks/simulated`,
correctly. All five tenant links, the guarantor link and the vendor link
signed in, and each tenant's four portal pages returned 200. The platform
console was walked end to end: password set from the setup link, two-factor
enrolled, and ten console pages returned 200. The navs for all five staff
personas match Acts 4 and 5, and the figures in Acts 1, 2, 3.5 and 7 were
read off the rebuilt database. The platform admin's two-factor was cleared
afterwards, so the next presenter enrols fresh. Earlier walks: 2026-09-23 and
2026-10-05.
