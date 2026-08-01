# Single-Family Rental Operations Platform

Multi-property single-family rental management platform (10–50 units, owner-operator + small team). Learning project, built to professional standards. Same stack and working conventions as the self-storage platform.

## How to work in this repo

- Product source of truth: `docs/prds/`. Build order: `docs/prds/06-backlog.md`, top to bottom, one item (or noted small cluster) per session.
- `docs/prds/07-decisions.md` OVERRIDES any conflicting PRD text. Never re-open a settled decision; append new decisions there instead.
- Stack: Next.js (App Router) + TypeScript, Postgres + Prisma, **Stripe Billing** (subscriptions drive recurring rent; Stripe is the source of truth for invoices and payments, per D-11), Tailwind CSS + shadcn, Auth.js, Resend (email), Twilio (SMS), Vitest/Playwright + axe + Lighthouse, deployed on Vercel.
- Monorepo layout mirrors the storage platform: `apps/web`, `packages/core` (domain logic, money math, metrics), `packages/db` (Prisma schema + migrations).
- Data model: use the canonical entity names in `docs/prds/00-master-prd.md` §13 (LegalEntity, Property, Unit, Lease, Tenant, LedgerEntry, Charge, Payment, Ticket, WorkOrder, Vendor, Inspection, Thread/Message, Notice, Task, Document, AuditLog, StaffUser, JurisdictionRule and supporting entities).
- Money is integer cents. All timestamps UTC in the DB, property-local timezone for display.
- **Jurisdiction rules are versioned, effective-dated configuration — never hardcoded** (D-4). Grace periods, late-fee caps, deposit deadlines, entry-notice hours, notice periods all read from `JurisdictionRule`. Compliance defaults are Texas, built per-state configurable. All legal/notice text is draft-only and not legal advice.
- **The evidence trail is the product.** Every message, notice, photo, payment, approval and privileged mutation is timestamped, append-only, and exportable.
- **Stripe is the system of record for money; `LedgerEntry` is an append-only projection of it** (D-11). Never write a charge or payment directly into the projection — it is built from Stripe webhooks, and a row that Stripe does not know about is a reconciliation bug. Corrections are reversing entries, never edits or deletes.
- **Stripe executes, core decides** (D-12). If a statute could change a number — late-fee amount and its cap, proration, allocation order, days-past-due — `packages/core` computes it and pushes it to Stripe as an invoice item. Never let Stripe generate a jurisdiction-dependent amount.
- Never store card, bank, or SSN data. Stripe-hosted fields and provider-hosted screening flows only.
- Screening and e-sign run against simulated adapters (PRD 00 §14) — never assume a real vendor API.
- Every module sends notifications through the notification engine (R-030) — no module hand-rolls its own sending.
- One `Task` entity serves every staff work queue. Do not invent a second queue table (D-9 — a lesson carried over from the storage build).
- Accessibility: WCAG 2.1 AA is an acceptance criterion on tenant- and vendor-facing work, not a later cleanup.
- After completing a backlog item, in this order: run tests → mark the item ✅ in `docs/prds/06-backlog.md` → add its entry to `docs/PROGRESS.md` → commit.
- `docs/PROGRESS.md` is the running narrative of what has been built. One entry per completed item, with its commit SHA and three things: **what it built**, **what it decided** (choices a later session must not silently reverse), and **what it left behind** (deliberate gaps and which item owns them). Note any real bug found along the way. Keep it factual — it is a record, not a changelog of intentions.
- Record the SHA in a small follow-up commit, not by amending. Amending changes the SHA you just wrote down, leaving `PROGRESS.md` pointing at a commit that no longer exists.
- Also update the same-day PRD when an item settles something the PRD left open, and append owner decisions to `07-decisions.md` with a new D-number rather than resolving them silently.
- Commit after every completed item with a message like `R-012: work order lifecycle`.
