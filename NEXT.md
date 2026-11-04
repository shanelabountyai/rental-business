**2026-11-04 (latest): R-287b done (`b051f77d`, D-392).** RLS stays off in production. It is enforced in vitest, e2e and CI only. D-392's restore note lists what turning it on needs.

A bare `go` is **R-282** (QuickBooks nightly sync and journal-entry builder, backlog row 260, size L). It is the earliest open row. OQ-22 (cash or accrual) is still open and decides the basis, so ask that first. R-297 still waits on OQ-16. R-296 (platform fee) is the other open item.

**Found in R-287b:** the Neon dev branch (`db:status:dev`) reports every migration as unapplied. Production functions run in `iad1` against a us-east-2 database, about 11ms per query. Moving them to `cle1` is an open option nobody has asked for.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4`, and check `pgrep -fl "$PWD.*playwright"` first. **A killed vitest leaves `node (vitest N)` workers alive.** Kill them by cwd (`lsof -a -p <pid> -d cwd`). Pass e2e specs as bare names: `npm run test:e2e -- platform-org-lifecycle`. A new platform action needs entries in BOTH `tests/invariants/actions.manifest.ts` and `platform.manifest.ts`. A new org-scoped table needs an `org_scope` trigger (R-285a) and an RLS policy from a migration. A unit test that calls an action and then reads another org's rows wraps the call in `asRequest` (R-287a). `cron.spec.ts:59` fails locally on about 1,800 accumulated orgs and passes in CI.

**Carry-overs:** each deployed database must re-run `db:seed` and `db:migrate` (R-291a, R-291b, R-300a, R-300b, R-298a, R-298b, R-287a). A real `StripeConnector` (including `disconnect`), `TwilioProvisioner`, `ResendProvisioner` and `VercelDomains` must exist before a provisioned org transacts. `application_fee.refunded` is not handled. OQ-27 is still open.

**Shane owes:** counsel on the reason list (OQ-16) and OQ-22 (cash or accrual). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint and its secret, plus `application_fee.created` on the platform endpoint.
