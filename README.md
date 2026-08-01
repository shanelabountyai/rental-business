# Rental Operations Platform

Multi-property single-family rental management platform (10–50 units, owner-operator plus a small team). Learning project, built to professional standards. Same stack and working conventions as the self-storage platform, deliberately divergent on one thing — see D-11.

## Getting started

```bash
npm install
cp .env.example .env.local        # fill in DATABASE_URL, DIRECT_URL, AUTH_SECRET
npm run db:generate
npm test                          # 17 money tests should pass
npm run dev
```

You need a Postgres database before `db:generate` is useful. Neon's free tier is what the storage repo uses; the pooled URL goes in `DATABASE_URL` and the direct one in `DIRECT_URL` (Prisma Migrate cannot run through a pooler).

`AUTH_SECRET` is generated with `openssl rand -base64 32`.

## Layout

```
apps/web          Next.js App Router application
packages/core     Domain logic — money math, and every number a statute could change
packages/db       Prisma schema, migrations, generated client
e2e               Playwright specs, including the axe accessibility gate
docs/prds         Product source of truth
docs/PROGRESS.md  Running record of what has been built
.claude/agents    Review agents (rental-operator ships here)
```

## Where the product lives

`docs/prds/` is the source of truth, not this README.

- `00-master-prd.md` — the full product requirements
- `06-backlog.md` — R-001 through R-097, in build order
- `07-decisions.md` — **overrides the PRDs.** Settled decisions; append, never re-open.

`CLAUDE.md` in the repo root tells Claude Code how to work here. Read it before your first session.

## What this scaffold already commits you to

These come from the decision log and are enforced in code, not just described:

- **Money is integer cents** (D-3). `packages/core/money` has no floats and asserts on non-integer input.
- **Stripe executes, core decides** (D-12). Late fees, proration, allocations and days-past-due are computed here and pushed to Stripe as invoice items. `clampToStateCap` is the shape of every statutory amount in the system.
- **Stripe Billing is the system of record for money** (D-11); `LedgerEntry` will be an append-only projection built from webhooks. This is the deliberate divergence from the storage repo, which stays ledger-driven.
- **Accessibility is a gate, not a cleanup.** `e2e/smoke.spec.ts` runs axe against WCAG 2.1 AA on the first route, and CI fails the build on a Lighthouse accessibility score below 1.0.
- **Property-local time** (D-3). The Vercel cron fires hourly; the job runner decides which properties are due in their own timezone. Nothing business-critical runs at UTC midnight.

## What this scaffold deliberately does not do

`packages/db/prisma/schema.prisma` has **no models**. R-002 owns the core data model, and it is the most consequential item in the backlog — scaffolding it here would decide the two-payer ledger shape (OQ-12) as a side effect of a config file. The header comment in that file lists the constraints R-002 has to honour.

Also deferred to the items that own them: `db:seed:demo` and `db:create-owner` scripts (R-012, R-007), the Stripe and Twilio SDKs (R-034, R-030), and everything in `packages/core` beyond money.

## Copying the other review agents

`.claude/agents/rental-operator.md` is domain-specific and ships here. The storage repo's `product-owner.md`, `ux-reviewer.md` and `accessibility-reviewer.md` are stack-generic — copy them across rather than having a second, worse version written from scratch.

## Before you build R-037 (tenant payments)

**OQ-11 is unresolved and blocks Milestone 3.** Stripe Billing cannot do autopay and partial payments on the same subscription: partial payments require the `send_invoice` collection method and are not supported on automatically-charged subscriptions. PAY-02 and PAY-03 are both Must. Decide it in `07-decisions.md` before writing payment code, not during.
