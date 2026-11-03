**2026-11-05 (latest): R-299 done (`d0bafc3`, D-385).** `/settings/export`: an owner types a code, and a `JobRun` writes one zip (a CSV per `orgId` table read from the schema, every Document file, and a manifest) to storage. It downloads from `/api/org-export/[id]` for 7 days.

A bare `go` is **R-300** (backlog row 277): the offboarding state machine and retention purge. Its retention windows are gated on OQ-26, so build to the defaults (90-day freeze, 7 years for append-only tables). R-299's `buildOrgExport` is the export that offboarding delivers. Recommend Opus: the item purges rows, freezes writes and pauses billing.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4` and check `pgrep -fl "$PWD.*playwright"` first. A bare `pgrep playwright` matches other projects' idle VS Code test servers. Pass e2e specs as bare names: `npm run test:e2e -- provisioning-checklist`. A unit-suite monitor must not grep a bare ` × `, because proration log lines contain one.

**Carry-overs:** each deployed database must re-run `db:seed` (owners gain `billing.connect`) and `db:migrate` for the R-291a and R-291b migrations. A real `StripeConnector`, `TwilioProvisioner`, `ResendProvisioner` and `VercelDomains` must exist before a provisioned org transacts. Provisioning org #0 on production would switch its texts off (D-375) and swap its inbound secret (D-377). `application_fee.refunded` is not handled. OQ-27 (write-capable support grants) is still open.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint in Stripe's dashboard and its secret, plus `application_fee.created` on the platform endpoint.
