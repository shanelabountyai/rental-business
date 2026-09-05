# Next session

## Pick up: R-170a — CI's red mobile-chrome sweep

`docs/prds/06-backlog.md` row 157a, Milestone 13 (Arc 3). Inserted ahead of
R-171 by owner decision D-175 on 2026-09-05.

D-171's races: `e2e/import.spec.ts:323` (bulk document upload) and
`e2e/inspections.spec.ts:142`/`:237` (checklist walk, item photo). Fail on
**mobile-chrome only**, under CI's concurrent full-sweep load; pass locally
in isolation, fast. Untouched by R-168a, R-169 and R-170 alike — four
consecutive red runs, none of them caused by the item that pushed them.

**Read D-171 and D-175 before starting.** D-171 records what has already been
ruled out (it was reproduced against unmodified `main` via `git stash`, and
`inspections.spec.ts` has zero file overlap with the item that first surfaced
it), and D-175 records the one constraint on the fix: **do not assert a cause
without positive evidence.** Reproduce under CI-like contention first — worker
count, the `mobile-chrome` viewport — then decide between the sticky/fixed
overlap hypothesis, a scroll-into-view race, and the retry budget. Recording
*unknown* is a legitimate outcome; guessing is not.

Model: **Opus** — a race whose whole difficulty is not jumping to a cause.

## Then: R-171 — every counter payment is counted twice in "collected"

`docs/prds/06-backlog.md` row 158, Milestone 13 (Arc 3).

D-169 found that `recordOfflinePayment` writes a rich `Payment` row AND a
second generic `channel: OTHER` row for the same money — `provider.record
OutOfBandPayment` fires an `invoice.updated` that `webhook.ts`'s
`writePayment` independently interprets as a payment, and its dedup key is
`stripePaymentIntentId`, which an out-of-band payment does not have. R-166
fixed the one consumer that mattered then; two more have since gone live and
both aggregate `Payment` without filtering the duplicate.

**Read D-169 in `07-decisions.md` before touching anything.** It records both
candidate fixes and why R-166 deliberately did not apply either — the fix
touches the shared webhook/billing-provider boundary that card, ACH, refund
and NSF all run through, and a rushed patch risks a quieter bug in money the
ledger already trusts. It also names the starting point: `e2e/deposits.spec.ts`'s
own comment on the poll it had to scope by channel to work around this.

Model: **Opus** — money correctness on a shared webhook boundary.
