# Deployment

What exists, what it is wired to, and what is still missing. Written when the
Vercel project was created (2026-08-11) because none of it is discoverable from
the repo alone — a dashboard setting is invisible to `git log`.

## The pieces

| Thing | Value |
|---|---|
| GitHub | `shanelabountyai/rental-business`, private |
| Vercel team | `shanelabountyai-8212s-projects` (`team_HJnm56EPKbrqWwd75nQEytBd`) |
| Vercel project | `rental-business` (`prj_jIRKum8dzMvYnnmSIVJjeYkQ99su`) |
| Root Directory | **`apps/web`** |
| Framework | Next.js (detected once Root Directory was right) |
| Build | `vercel-build` in `apps/web/package.json` |
| Neon `production` | `ep-cool-rain-aygtz3n8` — **Vercel reads this** |
| Neon `dev` | `ep-gentle-cell-ayd8m0qg` — **`.env.local` reads this** |
| Production URL | `https://rental-business-red.vercel.app` — **not public**: 401 from the app's own shared-password gate, `DEMO_ACCESS_PASSWORD` (checked 2026-09-23) |
| Custom domain | `rent.labintelligence.co` — attached 2026-09-23 (D-257); needs a Cloudflare `CNAME rent → 4e7d0f3b916b9516.vercel-dns-016.com`, DNS only |
| Deployment URLs | `rental-business-*-projects.vercel.app` — behind Vercel Authentication |

## Three things that are not obvious and each break the build

**1. Root Directory is `apps/web`, not the repo root.** This is an npm-workspaces
monorepo and the Next app is not at the top. Vercel resolves the framework
preset, `package.json` scripts, and `vercel.json` **relative to the Root
Directory** — so with the default `.` it detected "Other", ran no Next build,
and read no cron schedule.

**2. `vercel.json` therefore lives in `apps/web/`.** At the repo root it is read
by nothing, and the two crons declared in it never run. Nothing warns you: an
unscheduled cron looks exactly like a cron that has not fired yet.

`vercel.json` also **cannot carry a comment.** The schema is closed, so the
usual JSON `"//"` key fails the deployment during validation — before the build
starts, with a 0ms build and no build log to read. That is why the reason the
file lives here is written down in this document and not in the file itself.

**3. Nothing in `next build` generates the Prisma client.** `packages/db/generated/`
is gitignored, and the local build only works because `npm run db:generate` was
run by hand once and the output persisted in `node_modules`. A fresh CI checkout
has no client at all and fails at the first import. Hence `vercel-build`:

```
npx prisma generate --schema ../../packages/db/prisma/schema.prisma && next build
```

## Environment variables

The repo's `package.json` scripts all load `.env.local` via `dotenv-cli`. Vercel
does not — it injects the project's environment directly, which is why the
production build command is the bare one above and not `npm run build`.

### Set in Vercel Production

- `AUTH_SECRET` — **freshly generated, not the dev value.**
- `CRON_SECRET` — freshly generated.
- `NOTIFICATIONS_SANDBOX_TO` — every send is redirected here regardless of
  recipient. See "the two safety controls" below.
- `AUTH_URL` — the stable production alias above.
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` — the **test-mode** keys, same
  as dev. D-26 says test mode only; there is no live key anywhere by design.

The build itself is verified: a fresh checkout installs, generates the Prisma
client and completes `next build` in under a minute. What is missing is
runtime, not build — the site deploys and every page that touches the database
will fail until the two below are set.

### Still missing, and what each one costs

| Variable | Consequence of leaving it unset |
|---|---|
| `NEXT_PUBLIC_OPERATIONS_PHONE` | The vendor rejection screen shows no number — a dead end with no way out (R-098 built the link; it renders nothing when unset). |

## The two branches, and why they are this way round

Every script in `package.json` — `dev`, `build`, `test`, `test:e2e`, `db:seed`,
`db:seed --reset` — loads the same `.env.local`. So whichever branch that file
names is the branch the **test suite writes to**, and `db:seed --reset` retires
leases on it.

Until 2026-08-12 that file named the branch called `production` — the only one
there was. Weeks of fixtures, demo seeds and 27,392 notification-delivery rows
accumulated in it.

The fix was to branch, not to rename. `dev` was created **from** `production`,
so it inherited that state and local work carried on untouched; `production`
was then reset to an empty schema and handed to Vercel. Ordering mattered: the
test data only survives because `dev` copied it first.

**`.env.local` must never name `production` again.** A local `PORT=3100 npm run
test:e2e` against it would write to the live database.

Migrations are hand-written SQL and are **not** run by the build — deliberately.
Run them from a laptop, against `/tmp/prod.env` or equivalent, and look at what
they did:

```
npx dotenv -e <prod env file> -- npx prisma migrate deploy \
  --schema packages/db/prisma/schema.prisma
```

`prisma migrate reset` is destructive and now refuses to run under an AI agent
without explicit recorded consent. That guardrail is correct; do not paper over
it.

## What is actually deployed, and what was verified

Reset, migrated and seeded on 2026-08-12:

- 24 migrations applied to an empty `production` branch.
- `db:seed` — 6 roles and the TX statewide jurisdiction rule v1. **Reference
  data, not demo data**: `create-owner` refuses to run without the `owner` role,
  because D-5 makes roles data rather than code.
- Two owner accounts, both ordinary `StaffUser` + `StaffAssignment` rows with a
  null scope — there is no superuser in this system, by D-5.
- **No demo data.** `db:seed:demo` was deliberately not run.

Verified against the live site rather than assumed:

| Check | Result |
|---|---|
| `/reset-password?token=<real>` | 200, renders "Choose a new password" — proves Vercel env → Prisma → `production` branch → page |
| `/reset-password?token=<bogus>` | Renders the same form on purpose; `redeemToken` rejects it on submit. No oracle for whether a token is real |
| `/api/cron` with no or wrong bearer | 404 — deliberate, so a scanner learns nothing. `CRON_SECRET` is set and failing closed |
| An unknown path | 404 |

## Stripe webhooks

**Set up and verified 2026-08-13.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak`,
test mode, pointing at `/api/webhooks/stripe`, subscribed to exactly the ten
event types `packages/core/billing/events.ts` handles:

```
invoice.finalized          payment_intent.succeeded
invoice.updated            payment_intent.processing
invoice.payment_failed     payment_intent.payment_failed
invoice.voided             charge.refunded
setup_intent.succeeded     charge.dispute.created
```

`setup_intent.succeeded` was added with R-039a and is the only one that moves
no money — it is how a tenant's saved card becomes working autopay.

**`invoice.updated` replaced `invoice.payment_succeeded` on 2026-08-25
(R-038a, D-141), and swapping them back would reintroduce a shipped bug.**
Stripe sends no `invoice.payment_succeeded` at all for an invoice paid out
of band, so every offline check, money order and cash payment recorded since
R-038 pushed to Stripe correctly and never reached the ledger. `invoice.updated`
is the one event every money path shares, and the only one carrying
`previous_attributes` — which is what makes a part-payment projectable
without double-counting the instalment that closes the invoice. Subscribing
to both would double-count every card payment.

**When the handled list grows, this subscription has to grow with it.** A
handler nothing is subscribed to is dead code that looks live.

Ten rather than "all events": the route acknowledges unknown types
deliberately, so nothing breaks either way, but subscribing to everything
means paying delivery attempts on hundreds of types the product ignores and
makes a genuinely failing delivery harder to spot.

**Verified by signing a request, not by assuming.** The route returns 400 for
both a missing secret and a bad signature — on purpose, so a caller probing it
cannot tell which check failed — which means a 400 proves nothing about
whether the secret is right. The proof is a correctly-signed request: same
body, valid signature → **200**; same body, tampered signature → **400**.

**The local secret is a different one.** `stripe listen --forward-to
localhost:3000/api/webhooks/stripe` prints its own `whsec_`, valid only for
that session. Putting the dashboard secret in `.env.local` will not make local
forwarding work.

## The production alias is public

**Superseded (checked 2026-09-23):** the alias is now behind `apps/web/lib/demo-gate.ts`, HTTP Basic on `DEMO_ACCESS_PASSWORD`, which Production has set. It is the app's gate, not Vercel Authentication, so webhooks still reach `/api/`. The section below is the 2026-08-12 state.

`rental-business-red.vercel.app` serves the real login page with **no** Vercel
Authentication. That is how Vercel works — protection covers preview and
deployment URLs, not the production alias — and it is what you would want for a
real product, which is auth-gated at the application layer.

It is worth a deliberate decision rather than a default, because the app is not
finished. The database is empty, login is rate-limited per IP (R-003) and
privileged actions need a second factor (ROLE-05), so the exposure today is a
public sign-in form. To close it:

```
# ssoProtection.deploymentType: 'all'  (covers the production alias too)
```

Note the cost: with that on, **every** URL including the owner setup links
requires a Vercel session in the browser opening them.

## Rotate the Neon password

The `dev` branch credentials were pasted into a chat transcript during setup.
Nothing was exposed beyond that, but they should be rotated in the Neon console
(Branches → `dev` → Reset password) and `.env.local` updated. `production` uses
a different endpoint and was never pasted anywhere.

## AUTH_SECRET is not only a session secret

`packages/core/auth/secret-box.ts` keys its encryption off `AUTH_SECRET`.
Rotating it does not just log everyone out — it makes every previously
encrypted value undecryptable. Prod and dev hold different values on purpose,
and a fresh prod database is the only time changing it is free.

## The two safety controls, and why they matter more after deploying

`apps/web/lib/notifications/config.ts` reads two variables per send:

- `NOTIFICATIONS_ENABLED=false` — kill switch. Sends stop; notifications are
  still decided and recorded as suppressed, so nothing is lost.
- `NOTIFICATIONS_SANDBOX_TO` — redirects every send to one address while
  recording the address it *would* have used.

Notifications default to **enabled**, deliberately (a missing variable meaning
"off" would be a silent portfolio-wide outage). **Corrected 2026-09-22 (R-241):
the line below was stale.** `lib/notifications/provider.ts` has wired
`LiveChannelAdapter` since R-104 closed D-15's seam — not
`LoggingChannelAdapter` as this file said for five weeks. That does not mean
real sends are happening: `LiveChannelAdapter` itself falls back to the
console per-channel when `RESEND_API_KEY`/`RESEND_FROM` or
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_MESSAGING_SERVICE_SID` are
absent, and **on a production deployment (`VERCEL_ENV === 'production'`) an
unconfigured channel is refused rather than logged** — the send is recorded
`SUPPRESSED` / `unsupported_channel` instead of a false `SENT`
(`live-adapter.ts:18-26`). Neither set is in Vercel Production today (see
"Set in Vercel Production" above), so **every email and SMS this deployment
has ever tried to send has been suppressed, correctly and visibly, not
silently swallowed** — check `Notification.status = 'SUPPRESSED'` if that
needs confirming. See "Production cutover" below for what actually flips it.

## Uploads need a Blob store attached

R-100 swapped `lib/storage/index.ts` onto Vercel Blob, but **the store still has
to exist**. Until one is attached to the project, `BLOB_READ_WRITE_TOKEN` is
absent, the seam falls back to `LocalDiskStorageAdapter`, and every uploaded
document, vendor invoice and maintenance photo is written to a filesystem that
is gone by the next request — while the `Document` row claiming it exists
survives.

Attach one:

```
vercel blob create-store rental-business
```

Vercel injects `BLOB_READ_WRITE_TOKEN` into the project automatically once the
store is linked; nothing needs setting by hand. Redeploy afterwards.

**Check which one is live** on the authenticated cron response:
`storageDurable: true` means Blob, `false` means the per-invocation filesystem.
That field exists because a silent reversion — a detached store, a dropped env
var — otherwise looks exactly like everything working.

Blobs are written with `access: 'private'` (D-37). Reads stay authenticated
against the store token and go through the same routes as before, so nothing
about who may see a document changed.

## A deploy never re-runs `db:seed`

**D-240's unknown, answered (D-254).** `vercel-build` in
`apps/web/package.json` is exactly `npx prisma generate ... && next build` —
no seed script anywhere in it, and Vercel runs nothing else. A deploy applies
no migration and writes no row; both are manual laptop steps against the
production env file, as this document already says above. Nothing about that
changes at go-live.

## Production cutover: Stripe, Twilio, Resend

Everything today runs in test/simulated mode **by design** (D-26 for Stripe,
D-15/D-38 for Twilio and Resend) — this is the plan for the owner decision
that turns each one on for real, not a step to run now. Do the three
independently; nothing here requires flipping them together, and each has its
own external precondition outside this repo.

### Stripe — real money

1. **Owner decision first, recorded as a new D-number.** `StripeBillingProvider`
   (`apps/web/lib/billing/stripe-adapter.ts:104-116`) throws
   `LiveModeRefusedError` at construction on any `sk_live_`/`rk_live_` key —
   on purpose, per its own comment: "the owner authorised test mode
   specifically." There is no env flag that lifts this; the constructor has
   to be edited, reviewed and merged as its own deliberate PR. Do not do this
   speculatively ahead of the decision.
2. Get live keys from the Stripe dashboard (Live mode toggle), set
   `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in Vercel Production.
3. **Register a new, separate webhook endpoint in Live mode.** The endpoint
   documented above (`we_1U47bfJ7dm36XvZPk4ekxGak`) is test-mode only —
   Stripe does not carry a test-mode endpoint over to live. Subscribe to the
   same ten event types listed above (`packages/core/billing/events.ts`) and
   set the new live `STRIPE_WEBHOOK_SECRET` in Vercel.
4. Verify the same way test mode was verified: a correctly-signed live
   request returns 200, a tampered one returns 400. A 400 alone proves
   nothing, per the note above.
5. Run one real transaction for a real cent amount before onboarding a real
   tenant, and confirm it lands in `LedgerEntry` as a projection, per D-11 —
   this is the one path that moves real money and the one place a webhook
   miss is invisible until a tenant disputes a charge.
6. **Rollback:** revert the constructor PR, swap the Vercel keys back to
   test. Stripe is the source of money (D-11) — a live charge Stripe already
   processed cannot be undone by a code revert; it needs a real Stripe refund
   or dispute action, same as any other day-two Stripe operation.

### Twilio — real SMS

1. Confirm the 10DLC brand/campaign registration (D-15) has cleared —
   external, days to weeks, tracked outside this repo. Outbound SMS to US
   mobiles does not work without it regardless of what is set below.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`
   in Vercel Production.
3. **Set `NOTIFICATIONS_SANDBOX_TO` before step 2, not after** — the moment a
   real `TWILIO_MESSAGING_SERVICE_SID` is present, `LiveChannelAdapter` sends
   real texts to whoever is in the database, non-negotiably, the instant a
   test suite or a stray dev deploy points at this project. There is no code
   change to make: `apps/web/lib/notifications/provider.ts` has wired
   `LiveChannelAdapter` since R-104 already (see the correction above) — this
   is purely the three env vars.
4. Send one real SMS to a phone the team controls, confirm the delivery
   status callback lands (`StatusCallback` → `/api/sms/status`, wired only
   when `AUTH_URL` is set) and the `Notification` row reads `SENT` then
   `DELIVERED`, not `SUPPRESSED`.
5. **Rollback:** unset any one of the three Twilio vars — `LiveChannelAdapter`
   falls back to `SUPPRESSED` in production immediately, no deploy needed for
   Vercel env var changes to take effect (next request re-reads
   `process.env`, per `live-adapter.ts`'s own "read per call, never captured"
   comment).

### Resend — real email

1. Verify the sending domain in the Resend dashboard (SPF/DKIM published) —
   external, D-15.
2. Set `RESEND_API_KEY` and `RESEND_FROM` in Vercel Production.
3. Set `RESEND_WEBHOOK_SECRET` and register the delivery webhook
   (`/api/webhooks/resend`, Svix-signed) so bounces and complaints land as
   `Notification` status rather than a permanent `SENT` lie.
4. Send one real email to an address the team controls, confirm it arrives
   and the delivery webhook updates the row.
5. **Rollback:** same shape as Twilio — unset `RESEND_API_KEY` or
   `RESEND_FROM`, `LiveChannelAdapter` falls back to `SUPPRESSED` on the next
   request.

### What this plan deliberately does not cover

Legal review of each jurisdiction config before activating deposit-deadline
automation is its own release gate (06-backlog.md's Flagged gaps & conflicts,
item 6) — not a technical step and not satisfied by anything above.
