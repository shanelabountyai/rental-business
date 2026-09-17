# Next session

## R-219 is pushed. First confirm its CI run went green, then pick up R-220: the Arc 5 demo walk (D-28)

R-219 shipped as `213bfa0` (SHA recorded in the follow-up commit). **Read CI on the run itself with `gh run list --limit 5`.** If it is red, fix that first. Do not copy a CI line forward.

**Start here:** `docs/prds/06-backlog.md`, row 207 / **R-220**. Walk it in a browser at desktop and 412px, including the five public token surfaces.

## What R-219 established (D-237)

- `apps/web/lib/listings/prepare-job.ts` raises `listing.prepare` Tasks (subject Unit, dated on the notice day) by reading `Lease.noticeGivenAt` daily. It is a pull job, so it covers every writer of that column. Do not add per-action hooks.
- `/reports/leasing` shows days to list, counted from the notice to the first `Listing.publishedAt`.

## Worth checking on the R-220 walk

- A lease under notice in the demo seed should now have a `listing.prepare` Task once the job runs, and `/listing/new` for that unit should arrive pre-filled.

## Still open from R-218

- Packet photographs are listed but not embedded.
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older still stands; it is in git history at `9b9a10d:NEXT.md`.
