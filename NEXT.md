**2026-11-02 (latest): R-295b done (`f518558`, D-381); R-295 is complete.** A platform admin opens a live grant from the console (`grant.request`), a 60-second `SUPPORT_ENTRY` token lands on the org host's `/support/enter`, and a `__Host-support.session` cookie carries a read-only support actor, re-checked against the grant every request (PLAT-05/06/07/09 in `tests/invariants/plat-05-09.test.ts`). The banner's End now and `/support/ended` close it; owners read everything support did at `/settings/audit?grant=`. Shane's choice: billing re-sync now needs `payment.record` (PLAT-06 found it writing behind `ledger.read`).

A bare `go` is **R-276** (backlog row 254): custom domain per organisation, with the cookie and `AUTH_URL` per domain. It owns D-379's bug: staff sign-in (with or without MFA) and any `redirect()` from a server action on an org host land on `AUTH_URL`'s host. `e2e/support-access.spec.ts` works around it by waiting to leave the org host. Opus fits (auth and hosts).

**Machine note:** the full unit suite on nine workers, overlapping another project's sweep, took memory to 2% and the OS killed the session twice. Use `npm test -- --maxWorkers=4` and check `pgrep -fl playwright` first.

**Carry-overs:** each deployed database must re-run `db:seed` so owners gain `billing.connect`. A real `StripeConnector`, `TwilioProvisioner` and `ResendProvisioner` must exist before a provisioned org transacts. Provisioning org #0 on production would switch its texts off (D-375) and swap its inbound secret (D-377). `application_fee.refunded` is not handled. OQ-27 (write-capable support grants) is open.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint in Stripe's dashboard and its secret, plus `application_fee.created` on the platform endpoint.

CI for R-295b is not yet read: `gh run list --limit 3`.
