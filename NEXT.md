# Next session

## Pick up: R-174

`docs/prds/06-backlog.md`, row 161 — the next unticked row. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-173 (done, 25c717f)

`reachableElectronically(recipient)` in `apps/web/lib/notifications/send.ts`
is one predicate with two callers: PORTAL suppresses as `no_address` without
it, and D-38's `serve_notice_offline` task now fires on `smsBlocked ||
unreachable`. The tasks land in `/tasks?type=serve_notice_offline` (reached
from a banner on `/notifications`) and each hands over
`GET /tasks/[id]/printable` — R-062's renderer over the stored `Notification`
rows. **D-179** records why the predicate is about the recipient rather than
the template's channel list, and why the printable renders the stored rows
rather than re-deriving the message.

Left behind, owned by no item:

- A tenant with a phone but **no email** still gets a live PORTAL row and
  still cannot sign in (`tenant-magic-link` resolves by email only). SMS
  delivers the notice, so nothing is lost; the row is optimistic. The fix is
  a per-recipient-type credential table.
- Nothing links a `serve_notice_offline` task to a `Notice` row — the task's
  subject is the notification's idempotency key, not an entity id — so
  recording service means finding the notice by hand.

Still unowned from R-172: no staff field to type a real handover date for an
inherited tenancy whose move-in walk never happened;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment may write both a `PENDING` and a
`SETTLED` row. Recorded as **unknown** — verify against real Stripe.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.

**Check `gh run list --limit 5`** rather than assuming — R-173's own run is
the one to read.
