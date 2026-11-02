**2026-11-04 (latest): R-291a done (`180e9a4`, D-383).** R-291 was split: (a) is the derived ten-step checklist at `/settings/setup`, the console's checklist panel (reading `OrgHealth.checklist` booleans only), and "Go live" (`org.configure`, step-up, every step re-read from fresh facts). `Organization.status` is now `PROVISIONING | ACTIVE`. Existing orgs were backfilled ACTIVE, and the status gates only the slug change. Crons still run for provisioning orgs. Step 8 reads the platform-published reviewed rule until R-298.

A bare `go` is **R-291b** (backlog row 271b): "Send a test text" to the owner's phone through `notify()` and "Bill $1" on the org's connected Stripe account, both on `/settings/setup` and audited. Add the successful go-live e2e there, since step 9's facts become makeable. Sonnet fits: it is wiring through existing `notify()` and billing paths, with no new gate.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4` and check `pgrep -fl playwright` first. Pass e2e specs as bare names, inline: `npm run test:e2e -- provisioning-checklist platform-orgs.spec`. A zsh `$VAR` holding several names is not word-split, and an `e2e/` prefix matches nothing.

**Carry-overs:** each deployed database must re-run `db:seed` so owners gain `billing.connect`, and `db:migrate` for R-291a's migration. A real `StripeConnector`, `TwilioProvisioner`, `ResendProvisioner` and `VercelDomains` must exist before a provisioned org transacts. Provisioning org #0 on production would switch its texts off (D-375) and swap its inbound secret (D-377). `application_fee.refunded` is not handled. OQ-27 (write-capable support grants) is open.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint in Stripe's dashboard and its secret, plus `application_fee.created` on the platform endpoint.

CI for R-291a is not yet read: `gh run list --limit 4`.
