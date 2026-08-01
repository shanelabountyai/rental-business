# Start here — running this project with Claude Code

The scaffold is R-001. Everything below is how to drive the rest.

## The loop

One backlog item per session, top to bottom, no skipping ahead. The loop is in `CLAUDE.md` and it is short on purpose:

1. Read the item in `docs/prds/06-backlog.md` and its PRD references.
2. Build it. Tests are part of the item, not a follow-up.
3. `npm run lint && npm run typecheck && npm test && npm run build`
4. Mark the item ✅ in `06-backlog.md`.
5. Add the entry to `docs/PROGRESS.md` — what it built, what it decided, what it left behind.
6. Commit. Then record the SHA in a small follow-up commit, never by amending.

Amending changes the SHA you just wrote into `PROGRESS.md`, leaving the record pointing at a commit that no longer exists. That is a real mistake carried over from the storage build.

## Session 0 — verify the scaffold

Before writing anything new, prove the toolchain works end to end. Ask Claude Code:

> Verify the R-001 scaffold. Run lint, typecheck, test, and build. Then start the dev server and run the e2e suite including the axe scan. Report anything that fails and fix only what is genuinely broken in the scaffold — do not add features. When it is all green, mark R-001 complete in docs/prds/06-backlog.md and write its PROGRESS.md entry.

Expect 17 passing unit tests and one passing e2e spec. If `npm run db:generate` complains, your `DATABASE_URL` is not set yet — that is expected before you have a database, and the rest still runs.

## Session 1 — R-002, the data model

This is the highest-leverage session in the project. Do not let it get rushed.

> Build R-002 from docs/prds/06-backlog.md. Read docs/prds/00-master-prd.md §13 for the canonical entity names and docs/prds/07-decisions.md in full first — D-3, D-4, D-5, D-11 and D-12 all constrain this schema, and the header comment in packages/db/prisma/schema.prisma lists what they require. Before writing the schema, show me the entity list with the two-payer ledger shape you propose for OQ-12 and wait for me to confirm it. Then write the schema, generate the migration, and add constraint tests that prove the append-only and property-scoping invariants actually hold at the database level.

The pause before the schema is the point. OQ-12 (how a voucher lease carries two payers) is easier to decide now than to migrate later.

## Before R-037 — resolve OQ-11

**This blocks Milestone 3 and is not a preference.** Stripe Billing supports partial payments only on `send_invoice` subscriptions, not on automatically-charged ones. Autopay (PAY-02) needs `charge_automatically`. Partial payments (PAY-03) are how tenants actually pay. Both are Must.

Three resolutions are written into `07-decisions.md` under OQ-11. Pick one and record it as a new D-number before any payment code exists. If the honest answer turns out to be "we need both natively," that is a reason to re-open D-11 openly — not to half-build it and discover the conflict in R-039.

## Using the rental-operator agent

After a milestone, before starting the next one:

> Use the rental-operator agent to review what has been built so far against the backlog, and tell me the most consequential gap.

It is deliberately blunt and it reads `PROGRESS.md` first. Its job is to catch the things that only show up when someone who has actually run rentals looks at the product — the tenant who goes quiet, the vendor who will not log in, the deposit clock nobody started.

## Rules that will save you a bad afternoon

- **`07-decisions.md` wins over the PRDs.** If Claude Code proposes something that contradicts it, the decision log is right and the proposal is wrong — unless you consciously supersede the decision, the way D-11 superseded D-2.
- **Never let a statutory number become a literal.** Grace days, fee caps, deposit deadlines, notice hours all come from `JurisdictionRule` via `rulesFor(property, asOf)`. A hardcoded `5` for grace days is a bug in every state but one.
- **Never write directly into `LedgerEntry`.** It is a projection of Stripe (D-11). A row Stripe does not know about is a reconciliation bug that will surface as a wrong balance months later.
- **One `Task` entity for every staff queue** (D-9). The storage build had to consolidate seven queues after the fact. R-011 exists early precisely so nothing later invents its own.
- **No superuser flag, ever** (D-5). Unrestricted access is an ordinary `owner` role assignment with `propertyId = null` — grantable, revocable, and visible in the audit log.
- Legal artifacts — notices, lease templates, disposition letters — are drafts requiring attorney review. This is a learning project, not legal advice.
