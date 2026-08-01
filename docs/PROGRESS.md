# Progress — Rental Operations Platform

The running narrative of what has actually been built. One entry per completed backlog item, appended in build order. This is a record, not a plan — `06-backlog.md` holds intentions, this file holds facts.

**Entry format.** After completing an item: run tests → mark it ✅ in `06-backlog.md` → add the entry below → commit → record the SHA in a small follow-up commit (never by amending, which would change the SHA you just wrote down).

```
## R-0XX — <item name>
**Commit:** <sha>  ·  **Date:** YYYY-MM-DD

**What it built.** One or two sentences of fact.

**What it decided.** Choices a later session must not silently reverse. If it settles something the PRD left open, also update the PRD; if it's an owner-level call, append a D-number to `07-decisions.md` instead of deciding here.

**What it left behind.** Deliberate gaps, and which item owns each one. Note any real bug found along the way.
```

---

## R-001 — Monorepo & app scaffold
**Commit:** `d99e929` (scaffold), `8171958` (verification fixes)  ·  **Date:** 2026-08-01

**What it built.** The npm-workspaces monorepo (`apps/web`, `packages/core`, `packages/db`) on Next.js 16 App Router + TypeScript, Tailwind v4 + shadcn, Prisma 6 against Postgres, Vitest for unit tests and Playwright for e2e, and a CI workflow that runs migrate/seed/drift-check against a throwaway Postgres service before lint, typecheck, test, build, e2e + axe and Lighthouse. Secrets are handled by `.env.example` (names, committed) plus `.env.local` (values, gitignored), loaded through `dotenv-cli` so every script sees the same environment. The placeholder home route exercises the `packages/core` money helpers so the scaffold's own gates have something real to check.

**What it decided.**
- **Money helpers land in `packages/core` from commit one, and the home page consumes them.** The scaffold's gates are only meaningful if they run over real code; a placeholder page with no imports would have let `packages/core` rot untypechecked.
- **The accessibility gate exists before the first screen.** `e2e/smoke.spec.ts` runs `@axe-core/playwright` over `/` at `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` and asserts zero violations. Per CLAUDE.md this is an acceptance criterion, not a cleanup — a gate added after twenty screens is a gate that gets waived.
- **Playwright's default project is a phone viewport** (`Pixel 7`), with desktop second. Tenant, tech and vendor surfaces are mobile-primary per master PRD §6.5.
- **`packages/db` exports the Prisma client with an explicit `./generated/client/index.js` path**, not a bare directory import — bundler resolution papers over the directory form, plain Node running `seed.mts` does not and fails with `ERR_UNSUPPORTED_DIR_IMPORT`.
- **The whole monorepo is typechecked from `apps/web/tsconfig.json`** rather than from per-package tsconfigs, via `../../packages/**/*` in `include`. One tsc invocation, one config; revisit only if the packages need genuinely different compiler options.

**What it left behind.**
- `packages/db/prisma/schema.prisma` has no models yet, so CI's `prisma migrate deploy` is a no-op and `db:seed` seeds nothing. **R-002** owns the real schema and the first migration; the drift check in CI starts having teeth then.
- The home route at [apps/web/app/page.tsx](apps/web/app/page.tsx) is a placeholder. **R-007** replaces it with the admin shell, **R-013** with the owner dashboard.
- Vitest runs in the `node` environment with no jsdom and no React plugin. Deliberate — the tests this product needs (late-fee caps, proration, allocation order, days-past-due) are pure functions in `packages/core`. Whichever item writes the first component test adds jsdom.
- No auth, no RBAC, no property scoping. **R-003**/**R-004** own those; nothing in this commit should be read as an authorization pattern.
- Stripe underwriting: the backlog notes the multi-LLC KYB application is meant to be *submitted* at R-001 because it has real lead time (R-034 depends on it being done). That is an owner action outside the repo and was not performed by this session.

**Bugs found while verifying.**
- **CI could not have run.** `package-lock.json` was never committed, and the workflow's first step is `npm ci`, which hard-fails without a lockfile. Now committed.
- **The typecheck gate silently skipped `packages/db`.** `tsc` only follows the import graph, and nothing in `apps/web` imports `packages/db` yet, so a deliberate type error planted there passed `npm run typecheck` clean. `packages/core` was covered only incidentally, because the home page imports it. Fixed by adding the packages to `apps/web/tsconfig.json`'s `include` (with Prisma's generated client excluded); re-probed with planted errors in `packages/db/index.ts` and in a test file, and both now fail the gate. Worth noting the gate was about to be handed a whole workspace of Prisma code in R-002.
