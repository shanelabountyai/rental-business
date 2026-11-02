**2026-11-02 (latest): R-277b done (`58f42e9`, D-379).** Stripe Connect onboarding is on a simulated connector (`SimulatedStripeAccount`). Status moves NOT_STARTED → ONBOARDING → RESTRICTED → ENABLED only from `account.updated`, and to DISABLED on deauthorisation. Collection is refused at the provider, with an owner Task, until ENABLED. The platform fee lands in an append-only `PlatformFee` table (Shane's choice over a ledger kind). The page is `/money/stripe` (`billing.connect`, owner only). Org #0 cannot connect. R-277 is now fully ✅.

A bare `go` is **R-295** (support access grants; backlog row 273, PRD 11 §4.7). Open from D-373: the "held" owner notice in D-359 is suppressed while an org is off. Opus fits (permissions).

**Found in R-277b, not fixed (D-379):** in e2e, a server-action `redirect()` on an org host comes back as `/login` with the session intact, and staff sign-in on an org host lands on `AUTH_URL`'s host. Likely owner: R-276. Check whether R-295's actions redirect on an org host.

**Carry-overs:** each deployed database must re-run `db:seed` so owners gain `billing.connect`. A real `StripeConnector`, `TwilioProvisioner` and `ResendProvisioner` must exist before a provisioned org transacts. Provisioning org #0 on production would switch its texts off (D-375) and swap its inbound secret (D-377). `application_fee.refunded` is not handled.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint in Stripe's dashboard and its secret, plus `application_fee.created` on the platform endpoint.

CI for R-277b is not yet read: `gh run list --limit 3`.
