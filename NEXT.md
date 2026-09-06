# Next session

## Pick up: R-172

`docs/prds/06-backlog.md`, Milestone 13 (Arc 3) — the next unticked row after
158. Read its row and its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-171 (done, 8e35cb8)

D-169's doubled counter payment is closed by **D-177**, fixed at the writer:
`recordOfflinePayment` writes its `Payment` row before the push, and
`writePayment` claims it. **The backlog row's prescribed fix was wrong** —
filtering `channel` at the three consumer sites cannot work, because every
invoice-driven ONLINE payment also lands as `channel: OTHER`. The three sites
(`collectedVsBilled`, `entityCashSummaries`, `cureClockFor`) are untouched and
now correct.

One real bug found, deliberately left, **owned by no item** — and it is
recorded as *unknown*, not diagnosed:

- `writePayment` dedups only on `stripePaymentIntentId`, so an ACH payment on
  an invoice may write a `PENDING` row from `payment_intent.processing` and a
  separate `SETTLED` row from `invoice.updated`, leaving `inFlightCents` never
  clearing and the payment twice on a tenant's history. It hinges on whether
  the invoice object carries `payment_intent`: `packages/core/billing/events.ts`
  says it does not under the account's API version, while every test fixture
  and the demo seed put one there — so nothing in this repo can see it either
  way. **Verify against real Stripe before assuming either answer.**

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s, which is a page saying it is very large.

**Check `gh run list --limit 5`** rather than assuming — R-171's own run is the
one to read.
