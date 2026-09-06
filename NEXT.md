# Next session

## Pick up: R-173

`docs/prds/06-backlog.md`, row 160 — the next unticked row. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-172 (done, ec7dd21)

`Lease.moveInAt` now has a writer: finishing a MOVE_IN walk, both doorways.
`getTurnoverForUnit` falls back to `startsOn` and the clock stops. **D-178**
records the two rejected writers and why — `activatedAt` (signing day, not
handover, and no seed writes it) and access-code issuance (`AccessCode`
rotates for vendors, so a new row is not possession).

Left behind, owned by no item:

- No staff field to type a real handover date for an inherited tenancy whose
  move-in walk never happened. Those turns take the `startsOn` fallback, which
  is correct enough, but the actual date is recorded nowhere.
- `apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list, not
  by ownership — against this repo's own rule. Pre-existing, untouched.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment on an invoice may write both a
`PENDING` and a `SETTLED` row. Recorded as **unknown** — verify against real
Stripe before assuming either answer.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.

**Check `gh run list --limit 5`** rather than assuming — R-172's own run
(pushed 2026-09-06) is the one to read.
