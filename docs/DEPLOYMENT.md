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
| Neon (dev) | `ep-cool-rain-aygtz3n8` / `neondb`, us-east-2 |
| Neon (prod) | **not created yet** |
| Production URL | `https://rental-business-shanelabountyai-8212s-projects.vercel.app` |
| Access | Vercel Authentication on all deployments — team members only |

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
| `DATABASE_URL` / `DIRECT_URL` | **Build fails.** Waiting on a Neon `prod` branch — see below. |
| `STRIPE_WEBHOOK_SECRET` | **No money can enter the ledger.** The webhook route refuses outright without it, and under D-11 `LedgerEntry` is built *only* from webhooks. Create the endpoint after the first deploy, then set the signing secret here and locally (`stripe listen` gives a separate local one). |
| `OPERATIONS_PHONE` | The vendor rejection screen shows no number — a dead end with no way out (R-098 built the link; it renders nothing when unset). |

## Do not point production at the dev database

Every script in `package.json` — `dev`, `build`, `test`, `test:e2e`, `db:seed`,
`db:seed --reset` — loads the same `.env.local`. That is fine while there is one
environment. It stops being fine the moment a production deploy exists and the
obvious shortcut is taken: paste the same `DATABASE_URL` into Vercel.

Do that and a local `PORT=3100 npm run test:e2e` writes to production, and
`db:seed --reset` retires production leases. **Create the Neon `prod` branch
first, so the production URL exists before anything can be pointed at the dev
one.**

Migrations are hand-written SQL and are **not** run by the build. Run
`prisma migrate deploy` against the prod branch deliberately, from a laptop,
before the first deploy that expects a schema.

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
"off" would be a silent portfolio-wide outage). Today nothing actually leaves
the process, because `lib/notifications/provider.ts` still wires
`LoggingChannelAdapter` — that is D-15's seam, and Resend/Twilio are a change to
**one assignment**. The day that assignment changes, an unset
`NOTIFICATIONS_SANDBOX_TO` in any non-production environment means real texts to
whoever is in the database. Set it before that line changes, not with it.

## Uploads do not survive on Vercel

`lib/storage/index.ts` wires `LocalDiskStorageAdapter` under
`DOCUMENT_STORAGE_PATH`, defaulting to `.data/documents/`. On Vercel the
filesystem is ephemeral and per-invocation: every uploaded document, vendor
invoice and maintenance photo would be written to a disk that is gone on the
next request, while the database row claiming it exists survives.

D-14 anticipated exactly this and named the trigger — *"whenever this deploys
somewhere the filesystem isn't durable across instances"*. That condition is now
met. **R-100** owns the swap. Until it lands, treat uploads on the deployed
instance as non-functional rather than merely untested.
