# Next session

## R-189 is done and pushed — `d138189`, SHA recorded in `517229a`.

**CI has NOT been checked for this item.** Run `gh run list --limit 5` and
confirm the run on `517229a` (or `d138189` — auto job cancellation usually
leaves only the SHA commit's run). Do not copy this or any earlier green line
forward; R-141's lesson is eleven entries inheriting a claim instead of running
the three-second command. R-188's own run WAS checked this session and was
green (`34427150842`).

## Start here: row 177, R-190

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"), rows 174–189, sourced from
`docs/reviews/2026-09-09-operator-review.md` and recorded as D-201. Work top to
bottom; the WRONG rows come first. R-190 is the next one — `jobs/runner.ts:252`
passes the real `now` alongside a *historical* `businessDate` when catching up
missed days, so six of the twenty-two jobs do today's work under yesterday's
label and the `JobRun` is then recorded SUCCEEDED for that date. Review
finding 4, which names the six.

Thirteen of the fifteen rows were **inherited evidence**; findings 1, 5, and now
3 have been verified at build time. R-150's rule stands: re-verify the file and
line before building, and if the claim is wrong, say so in the entry rather than
building around it. R-187's, R-188's and R-189's claims were all verified and
all correct.

## What R-189 changed that the next rows touch

- **`attachMessageDocumentsToTicket`** (`apps/web/lib/comms/inbound-attachments.ts`)
  is now the ONLY place an inbound `Document` gains a `ticketId`. Both
  `sms-intake.ts` and `email-intake.ts` call it, on **both** the
  `ticket_opened` and `thread_only` outcomes. The email path's inline
  `updateMany` is gone. D-204.
- `receiveInboundMessage` takes a new optional `attachmentsDeclared`, which is
  what `UnroutedMessage.attachmentsDropped` now records. It defaults to
  `attachments.length`, so every existing caller is unchanged.
- `MAX_ATTACHMENT_BYTES` and `MAX_ATTACHMENT_COUNT` are now **exported** from
  `inbound-attachments.ts` (they were private `MAX_BYTES` / `MAX_COUNT`).
  `twilio-media.ts` is the second reader; a third must not copy them.
- New `apps/web/lib/comms/twilio-media.ts` — the first module in this repo that
  makes an outbound fetch from *inbound* handling. It is where the host
  allowlist and the size cap live.
- `sms-intake.test.ts`'s `afterAll` now deletes `Document` rows by
  `propertyId`, before the property is deactivated.

## Found in R-189, owned by nobody

- **Nothing backfills the photographs discarded before this item.** Those bytes
  were never fetched and no longer exist to fetch — Twilio retains media for a
  limited window and the URLs were never stored either.
- **Nothing re-parents a photograph onto a ticket opened AFTER the message that
  carried it.** A text an hour before staff open a ticket by hand still leaves
  the picture on the message alone. Both intake paths only parent at the moment
  they decide the ticket.
- **The filename is manufactured** (`texted-1.jpeg`) because Twilio sends none,
  so two photographs in one thread are told apart by thumbnail and timestamp,
  not by name.
- **The memory ceiling on a media fetch is one CDN response bounded by the
  timeout.** `Content-Length` is checked before the body is read, but a lying
  header is only caught after buffering. Worth knowing before that module is
  pointed at any other provider.
- **The wire between the fetcher and Twilio is untested and cannot be tested
  from here** — same limit R-104's drivers have. The refusals are unit-tested
  against a stubbed `fetch`; the route's reading of `NumMedia` is proved e2e
  through a deliberately non-Twilio media URL.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is nine migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and including
`20260907120000_r175_payment_plans`, so it has no `PaymentPlan` table at all.
`npm run dev` reads `.env.local`, so a walk against the dev branch would 500 on
anything built since R-165. `npm run db:migrate:dev` is the whole fix; it was
outside R-187's, R-188's and R-189's scope and has still not been run.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date (it lands in both `arrearsCents` and `chargesSince`); no
e2e walks the new wrongly-completed warning.

## Still outstanding from R-188, owned by nobody

The deposit reminder job's already-flagged guard keys on `leaseId`, not on the
deposit, so a lease holding two deposits (SECURITY + PET) flags once for both.
Pre-existing and untouched. **Note this is the same shape as R-190's neighbour
R-191** — an already-flagged guard that cannot fire twice — and R-191 is two
rows away, so read them together before fixing either.

## Binding for every row in this arc

The review's **"do not build"** list, now three arcs deep and repeated in the
Milestone 14 header and D-201:

- No accrual or interest engine before a second state is onboarded.
- No Stripe Connect. Still a legal-structure decision nobody has taken.
- No settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
  `TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds.
- **No second queue.** D-9 has been paid for three times. R-191 and R-197 want
  the *existing* Task queue reachable and correctly dated.
- **No backfill of anything** — D-169's doubled `Payment` rows, R-038a's
  no-ledger payments, R-187's wrongly-completed plans, and now R-189's
  discarded photographs.
- No per-stage turn table, no second definition of "days vacant".

**R-194** is the arc's other Needs counsel row (does a partial payment cure, and
does accepting it waive — the second is already a three-valued
`JurisdictionRule` field). **R-192 records its production frequency as unknown**
— code path verified, frequency not, pending real Stripe redelivery behaviour.

## Still true from earlier handoffs

- **Rows 81 (R-081), 97 (R-097) and 155 (R-168) are SPLIT-PARENT
  placeholders.** Every child shipped. Ticking them is bookkeeping.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item. (R-189 is NOT an
  instance of this: Twilio was already a live relationship.)
- **`e2e/leases.spec.ts`'s cleanup flake has a row** — 189 / R-202, at the end
  of the arc. It costs CI time on every push, so pull it forward if a sweep
  goes red on `WorkOrder_unitId_fkey` rather than treating it as new.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197) — the second kind hides from an element-by-element
probe; only `document.documentElement.scrollWidth` sees it.

**Use `npm run test:e2e`, never bare `npx playwright test`.** The latter gives
28 failures in 0–222ms with no `DATABASE_URL`, which reads exactly like the
jetsam symptom CLAUDE.md warns about and is not it. (`--list` is safe without
it, and is how you get the real expected test count.)

**Prove a new assertion against the reverted fix** (D-197). R-189 did this four
times, one revert per claim, and each turned exactly one test red — which is
what showed the four tests guard four things rather than one thing four times.

**A fixture that looks complete can still be missing the field under test.**
Check what the production writer sets, not what the fixture has.

**A wall of hook timeouts in unrelated `afterAll`s is an environment symptom.**
Check `pg_stat_activity` for sibling projects before reading a stack trace.
R-189's own full unit run was clean (3090 passed / 4 skipped / 3094).

**A seed defect is only visible on a walk** (D-28).

## Leftovers still owned by nobody

From R-186: the demo's lease term is `startsInDays + termMonths * 30`, so a
twelve-month lease reads *30 Sept 2026 to 25 Sept 2027*; the seeded draft has
no utilities and no addenda; the staff-side `/leases/[id]` e-sign panel was
never walked in a browser; `storageIsRemote` skips the draft document, so with
`BLOB_READ_WRITE_TOKEN` set the defect returns.

From R-185: `packages/core` can test the catalogue EXAMPLES but not the values
— the three builders are `server-only` Prisma modules in `apps/web`.
`demoLeaseMergeValues` is the only tested one. `rent.due_day` still renders as
a bare `'1'` rather than `'the 1st'`, left alone deliberately.

From R-184: `leaseStatusLabel`'s `/money` caller has no tests; `from
{prospect.source}` prints the raw column, so the prospect header reads
"Applied · from zillow"; `/workorders/[id]/timeline` was the one route family
the phone-width pass skipped.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`, and
`Deposit.escrowAccountRef` / `interestAccruedCents` are written by nothing —
deliberate, and not to be started until such a property is onboarded.

From R-182: `assessEvidence`'s presumption period takes no day-count basis, and
nothing seeds a holiday list for any state.

From R-181: a texted-in tenant never gets the quotable reference; the
acknowledgement rides the hourly outbox cron so it can lag an hour;
`entry.notice` names no ticket; no e2e walks intake → acknowledgement.

From R-180: no processing fee, so no net payout can be stated; `HAP_ACH` would
be counted as a Stripe settlement if anything wrote it.

From R-178: no `cases.stalled` Task links to its subject; `TURN_STAGE_DAYS`
unconfigurable; `draftPunchListFromInspection` findings are unstaged.

From R-177: the R-032c "was this fixed?" SMS default and the TCPA question are
owner decisions, recorded and unfixed. Email-intake tickets get no clarify
link; `e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

From R-176: nothing warns portfolio-wide that a unit was listed with an open
re-key; a CANCELED re-key reads like one that never happened.

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in.

From R-172: no staff field for a real handover date on an inherited tenancy;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as **unknown**
— verify against real Stripe. (R-192 is the adjacent, verified defect.)

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
