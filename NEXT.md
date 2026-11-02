**2026-11-05 (latest): R-291b done (`28f88cd`, D-384).** Step 9's "Send a test text" and "Bill me $1" are on `/settings/setup`. The paid $1 lands in `SetupTestPayment` (never `LedgerEntry`), from the paid `invoice.updated` marked `metadata.purpose = setup_test`. The e2e now walks to a successful go-live.

A bare `go` is **R-299** (backlog row 276): the full organisation export. R-297 is gated on OQ-16, and R-298 depends on R-278, which is gated on OQ-14. Recommend Opus, because the export reads every org-owned table and must not leak another org's rows.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4` and check `pgrep -fl "$PWD.*playwright"` first. A bare `pgrep playwright` matches other projects' idle VS Code test servers. Pass e2e specs as bare names: `npm run test:e2e -- provisioning-checklist`. A unit-suite monitor must not grep a bare ` × `, because proration log lines contain one.

**Carry-overs:** each deployed database must re-run `db:seed` (owners gain `billing.connect`) and `db:migrate` for the R-291a and R-291b migrations. A real `StripeConnector`, `TwilioProvisioner`, `ResendProvisioner` and `VercelDomains` must exist before a provisioned org transacts. Provisioning org #0 on production would switch its texts off (D-375) and swap its inbound secret (D-377). `application_fee.refunded` is not handled. OQ-27 (write-capable support grants) is still open.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint in Stripe's dashboard and its secret, plus `application_fee.created` on the platform endpoint.
