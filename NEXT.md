# Next session

## R-216 is done. Pick up R-217: nothing measures a habitability complaint against a repair deadline.

R-216 shipped as `7f227f7`. **Read CI on the run itself with `gh run list --limit 5`.** Do not copy a CI line forward.

**Start here:** `docs/prds/06-backlog.md`, row 204 / **R-217**. Re-verify the finding before touching anything. The record is twelve for twelve. R-217 **needs a migration** (`habitabilityRepairDays` on `JurisdictionRule`), so run `npm run db:ci` before pushing, and it is the row that still **Needs counsel**.

## What R-216 established (D-234)

- The sign-in forms take an email or a mobile number. **A phone signs in only somebody with no email on file, and only when exactly one active row matches.**
- **`canTextAuthLink` (send.ts) is the one answer to "can this person get into the portal"**: an email, or a phone that is not blocked and has SMS consent. `notify()`'s PORTAL address and `canReceiveAuthLink` (async, takes the recipient type) both read it.
- **The consent gate is not bypassed for a sign-in text.** A phone-only tenant without consent still cannot sign in.
- **`uniquePhone()` is not a NANP number** (eleven digits after +1). Any test that types a phone into a form needs a real ten-digit number.

## What R-216 left behind

- No staff-issued code for a tenant with neither an email nor a phone.
- No e2e for the guarantor phone path or for the no-consent refusal.
- Nothing prompts staff to record consent for a phone-only tenant who cannot sign in.

Everything else in the previous NEXT.md (the R-215 and earlier leftovers, the standing traps, and R-220's demo-walk debts) still stands. It is in git history at `7fb5ffb:NEXT.md`.
