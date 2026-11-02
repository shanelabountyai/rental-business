**2026-11-03 (latest): R-276 done (`b7edbc9`, D-382).** A custom domain per org on a simulated Vercel: the console's *Custom domain (Vercel)* panel adds it and polls it, and `Organization.customDomain` is set only once verified. From then on that host names the org and carries every link `authUrl` builds. **D-379 is closed, both symptoms:** the org's Auth.js redirects are relative now, and every host read goes through `requestHost` (`x-forwarded-host` first), because Next renders an action's `redirect()` target with an internal fetch that drops Host. The simulator refuses to start where `VERCEL=1`, so production cannot be pointed at a pretend domain. Twilio signatures now check the org's own URL.

A bare `go` is **R-291** (backlog row 271): the provisioning checklist at `/settings/setup` and on the console. Opus or Sonnet: it is mostly derived-status reads, but go-live flips `Organization.status`.

**Machine note:** the full unit suite on nine workers, overlapping another project's sweep, took memory to 2% and the OS killed the session twice. Use `npm test -- --maxWorkers=4` and check `pgrep -fl playwright` first.

**Carry-overs:** each deployed database must re-run `db:seed` so owners gain `billing.connect`. A real `StripeConnector`, `TwilioProvisioner`, `ResendProvisioner` and `VercelDomains` must exist before a provisioned org transacts. Provisioning org #0 on production would switch its texts off (D-375) and swap its inbound secret (D-377). `application_fee.refunded` is not handled. OQ-27 (write-capable support grants) is open.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint in Stripe's dashboard and its secret, plus `application_fee.created` on the platform endpoint.

CI for R-295b and R-276 is not yet read: `gh run list --limit 4`.
