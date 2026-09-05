# Next session

## Pick up: R-171 — every counter payment is counted twice in "collected"

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

## Context from R-170a (done, 066c4c0)

CI's four-run red streak is fixed and D-171 is closed by **D-176**. It was
never a race: an unconstrained `<select>` widened the page past the phone
viewport, Chromium's mobile emulation expanded the layout viewport, and
Playwright's click coordinates stopped matching. **Check `gh run list --limit 5`
rather than assuming** — R-170a's own run is the first that should be green,
and CLAUDE.md's longest warning is about that sentence being copied forward
instead of checked.

Two things R-170a left unowned, neither blocking:
- `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against `/staff`'s
  2.2s. axe is superlinear in node count, so that is a page saying it is very
  large. Noted in `e2e/staff.spec.ts`, owned by no item.
- CI now uploads a real `playwright-report/` (the `html` reporter is on). The
  next red run should arrive with its traces attached — if it does not, that
  is worth a look, because the upload has silently produced nothing for months.
