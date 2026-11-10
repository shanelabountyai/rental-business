**2026-11-05 (latest): R-296 done** (`95c8d428`, D-402). Each org's platform fee (`Organization.platformFeeBps`) is set on `/platform/orgs/[slug]` (`org.feeSet`, step-up, reason, owners emailed). The Stripe driver puts it on new subscriptions, one-off invoices and portal PaymentIntents (on the principal). Never on org #0, which is refused. A change reaches live subscriptions through `syncLeasePayer` (`fee_updated`), and the nightly run retries. CI is green (run 42166416127).

**2026-11-06: R-307 done** (`8846e09d`, D-403). CI is green (run 42272317061). `application_fee.refunded` now writes append-only `PlatformFeeRefund` rows, one per Stripe fee refund. Each deployed DB must run `db:migrate` (`20261117100000_platform_fee_refund`).

**2026-11-09: R-267 done** (`6e6ca0dc`, D-404, OQ-15 answered: split by role). `message.send_freeform` goes to owner and manager; techs send tenants templates only. Each deployed DB must re-run `db:seed`. CI is green (run 42669923319).

**2026-11-09: R-268 done** (`fa5d4f55`, D-405, OQ-20 answered: wording slots only). Owners set a greeting and closing on four automated emails at `/messages/settings`. Each deployed DB must run `db:migrate` (`20261118100000_template_wording`). CI is green (run 42679790464).

**2026-11-09: R-272 done** (`e0560815`, D-406: Twilio's Messaging Service queue paces sends; the review list estimates) **and R-273 done** (D-407: the texting number's toll-free or 10DLC status on `/messages/settings`). Org #0's live Twilio is configured in `.env.local`: toll-free 877 number, verification approved, and a live send was delivered. `.env.test` and `.env.demo` blank the keys on purpose; never remove that.

**CLOSING OUT (D-408, 2026-11-10).** Shane chose closure over answering OQ-14. Four deliverables, one per session:

1. ✅ `docs/DEMO.md` — done 2026-11-10. `DEMO-SCRIPT.md` renamed, Acts 7 (messaging) and 8 (platform console) added, every command run against a freshly rebuilt `rental_demo`. New `db:create-platform-admin:demo` script; `.env.demo` gained `PLATFORM_HOST` and `ORG_BASE_DOMAIN`.
2. ✅ The exec brief — done 2026-11-10. It already existed (2026-10-26) and was refreshed in place, not rebuilt: https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB. Measured that day: 3,969 unit tests (302 files), 1,430 e2e (118 specs, both projects), 1,171 commits, 408 decisions, 101 days. Also in `docs/RELEASE_NOTES.md`. **NEXT: item 3.**
3. ✅ LinkedIn posts — done 2026-11-10. Ledger posts #166 (Impact, effective-dated rules) and #167 (MarTech, date formatted in the renderer), queued after #164. Ledger: https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i. 13 rental posts existed already. **NEXT: item 4.**
4. Cost review: Vercel project, Neon, crons in `apps/web/vercel.json`, CI, Stripe/Twilio/Resend keys. Keep / slow / off, with restore notes, as a D-number.

`rental_demo_bak_20261110` is the pre-closure demo DB, kept as a backup; `dropdb` it once satisfied.

**Left by R-296:** the simulator never emits `application_fee.created`, so `PlatformFee` is empty without a Stripe key, the demo included. Each deployed DB must run `db:migrate` (`20261116100000_platform_fee`). `move-out-copy.test.ts` has a cleanup race on `Lease_renewedFromLeaseId_fkey` under full-suite load. It passes alone.

**Left by R-297:** a new org starts with no criteria and no reasons; step 8 says so. The criterion check inside `recordScreeningDecision` has no test that drives the action. The list's wording is still gated on OQ-16. Each deployed DB must run `db:migrate` (`20261115100000_per_org_screening_criteria`).

**Left by R-284:** the request budget is per run, not per minute across runs (a 429 is retried). The budget and deadline have no test.

**Left by R-283:** the real Intuit driver must also implement `listJournalEntries`. With the simulator, the QuickBooks side lives in process memory, so a deployed page can show phantom variance.

**Left by R-282a/b:**
- Deposit disposition never reaches `LedgerEntry`, so Security Deposits Held only grows in QuickBooks.
- Dispute fees are not read.

**Real-Intuit carry-over:** Intuit needs one registered redirect URI, but the callback is built on each org's host. The real driver needs a callback on the platform host that hands back to the org host.

**`rental_test` rebuilt 2026-11-06** with `npm run db:reset:test`: 3.3 GB and 1.84M `Notification` rows went to 18 MB. The full unit suite then passed: 3954 passed and 4 skipped (3958 total) in 26s with `--maxWorkers=4`, so the notification-file timeouts are gone. Run the reset again if it grows back.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4`. A killed vitest leaves `node (vitest N)` workers alive; kill them by cwd. Pass e2e specs as bare names. A new org-scoped table needs an `org_scope` trigger and an RLS policy. A unit test that crosses orgs wraps the call in `asRequest`. A new server action needs its `actions.manifest.ts` entry, and `unreached` if the fixture cannot reach its own-org path. `cron.spec.ts:59` fails locally and passes in CI. **Check `gh run list --limit 3` after each push.** R-283's red run went unnoticed.

**Carry-overs:** each deployed database must re-run `db:seed` and `db:migrate` (R-291a, R-291b, R-300a, R-300b, R-298a, R-298b, R-287a, R-284, R-297, R-296, R-307, R-267 seed only, R-268). The real StripeConnector, TwilioProvisioner, ResendProvisioner and VercelDomains still have to be built. OQ-27 is open. The Neon dev branch reports every migration as unapplied.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint and its secret.
